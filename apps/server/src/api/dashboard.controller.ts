import { Body, Controller, ForbiddenException, Get, HttpCode, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { StatusReportBody } from '@workforce/contracts';
import { sql } from 'drizzle-orm';
import { canViewPerson, CurrentUser } from '../auth/auth.guard';
import type { AuthUser } from '../auth/session.service';
import { intParam, parseBody } from '../common/zod';
import { agentDtos, feedEvents } from '../dto';
import { type Db, InjectDb } from '../infra/infra.module';
import { MetricsService } from '../metrics/metrics.service';

@Controller('api')
export class DashboardController {
  constructor(
    private readonly metrics: MetricsService,
    @InjectDb() private readonly db: Db,
  ) {}

  @Get('overview')
  overview() {
    return this.metrics.overview();
  }

  @Get('attention')
  attention(@CurrentUser() user: AuthUser) {
    return this.metrics.attention(user);
  }

  @Get('feed')
  feed(@Query('limit') limit?: string, @Query('before') before?: string) {
    return this.metrics.feed(intParam(limit, 60, 1, 200), before);
  }

  @Get('team')
  team() {
    return this.metrics.team();
  }

  @Get('flow')
  flow(@Query('days') days?: string) {
    return this.metrics.flow(intParam(days, 90, 7, 365));
  }

  @Get('reviews')
  reviews(@CurrentUser() user: AuthUser, @Query('days') days?: string) {
    return this.metrics.reviews(user, intParam(days, 30, 7, 365));
  }

  @Get('ci')
  ci(@Query('days') days?: string) {
    return this.metrics.ci(intParam(days, 14, 1, 90));
  }

  @Get('people')
  async people(@CurrentUser() user: AuthUser) {
    // Names and teams are visible to everyone; individual metrics are not.
    const r = await this.db.execute<any>(sql`
      SELECT e.id, e.display_name AS name, e.avatar_url AS "avatarUrl", t.name AS team, e.team_id AS "teamId"
      FROM employees e LEFT JOIN teams t ON t.id = e.team_id WHERE e.active ORDER BY t.name NULLS LAST, e.display_name`);
    return r.rows.map((p: any) => ({ ...p, canView: canViewPerson(user, p) }));
  }

  @Get('people/:id')
  async person(@CurrentUser() user: AuthUser, @Param('id') id: string, @Query('days') days?: string) {
    const target = (await this.db.execute<any>(sql`SELECT id, team_id AS "teamId" FROM employees WHERE id = ${id}`)).rows[0];
    if (!target) throw new NotFoundException();
    if (!canViewPerson(user, target)) {
      throw new ForbiddenException('Individual metrics are visible to the person, their team lead and admins');
    }
    const data = await this.metrics.person(id, intParam(days, 30, 7, 365));
    if (!data) throw new NotFoundException();
    if (user.id !== id) {
      // Viewing someone else's metrics is always audited, and they can see who looked.
      await this.db.execute(sql`
        INSERT INTO audit_log (id, actor_id, action, target) VALUES (gen_random_uuid()::text, ${user.id}, 'VIEW_PERSON_METRICS', ${id})`);
    }
    const viewers = await this.db.execute<any>(sql`
      SELECT e.display_name AS name, max(a.at) AS at FROM audit_log a JOIN employees e ON e.id = a.actor_id
      WHERE a.target = ${id} AND a.action = 'VIEW_PERSON_METRICS' AND a.at > now() - interval '30 days'
      GROUP BY e.display_name ORDER BY max(a.at) DESC LIMIT 20`);
    return { ...data, viewedBy: user.id === id ? viewers.rows : undefined };
  }

  /** Self-reported status: shown with a "reported" label, never counted in metrics. */
  @Post('status')
  @HttpCode(200)
  async reportStatus(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    const { activity, note } = parseBody(StatusReportBody, body);
    const now = new Date();
    const blocked = activity === 'BLOCKED';
    const summary = blocked ? `reported being blocked${note ? `: ${note}` : ''}` : 'cleared their blocked status';
    const verb = blocked ? 'status.blocked' : 'status.cleared';
    await this.db.transaction(async (tx) => {
      const ev = await tx.execute<{ id: string }>(sql`
        INSERT INTO events (id, dedupe_key, occurred_at, actor_id, verb, subject_type, subject_id, provenance, summary, data)
        VALUES (gen_random_uuid()::text, ${`self:${user.id}:${now.getTime()}`}, ${now}, ${user.id}, ${verb}, 'STATUS', ${user.id},
                'SELF_REPORTED', ${summary}, ${JSON.stringify({ note: note ?? null })}::jsonb)
        RETURNING id`);
      if (blocked) {
        await tx.execute(sql`
          INSERT INTO agent_states (employee_id, activity, provenance, source_verb, source_label, occurred_at, expires_at)
          VALUES (${user.id}, 'BLOCKED', 'SELF_REPORTED', ${verb}, ${summary}, ${now}, ${now}::timestamptz + interval '4 hours')
          ON CONFLICT (employee_id) DO UPDATE SET activity = 'BLOCKED', provenance = 'SELF_REPORTED', source_verb = EXCLUDED.source_verb,
            source_label = EXCLUDED.source_label, source_url = NULL, occurred_at = EXCLUDED.occurred_at,
            expires_at = EXCLUDED.expires_at, updated_at = now()`);
      } else {
        await tx.execute(sql`DELETE FROM agent_states WHERE employee_id = ${user.id} AND activity = 'BLOCKED'`);
      }
      const [fe] = await feedEvents(tx, sql`ev.id = ${ev.rows[0].id}`, 1);
      const [agent] = await agentDtos(tx, sql`e.id = ${user.id}`, now);
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('workforce-outbox-order'))`);
      await tx.execute(sql`INSERT INTO outbox (topic, payload) VALUES ('org', ${JSON.stringify({ type: 'event', event: fe })}::jsonb)`);
      await tx.execute(sql`INSERT INTO outbox (topic, payload) VALUES ('org', ${JSON.stringify({ type: 'agent', agent })}::jsonb)`);
    });
    return { ok: true };
  }
}
