import { InjectQueue } from '@nestjs/bullmq';
import { BadRequestException, Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { BackfillBody, LinkIdentityBody } from '@workforce/contracts';
import type { Queue } from 'bullmq';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { CurrentUser, Roles } from '../auth/auth.guard';
import type { AuthUser } from '../auth/session.service';
import { parseBody } from '../common/zod';
import { GithubAppClient } from '../github/app-client';
import { IdentityService } from '../identity/identity.service';
import { type Db, type Env, InjectDb, InjectEnv } from '../infra/infra.module';
import { BACKFILL_QUEUE, NORMALIZE_QUEUE, normalizeJobOptions } from '../infra/queues';

const NewEmployee = z.object({
  displayName: z.string().min(1).max(120),
  email: z.string().email().optional(),
  role: z.enum(['ADMIN', 'LEAD', 'MEMBER']).default('MEMBER'),
  teamId: z.string().nullable().optional(),
  githubId: z.string().regex(/^\d+$/).optional(),
});
const UpdateEmployee = z.object({
  employeeId: z.string(),
  role: z.enum(['ADMIN', 'LEAD', 'MEMBER']).optional(),
  teamId: z.string().nullable().optional(),
  active: z.boolean().optional(),
});
const NewTeam = z.object({
  name: z.string().min(1).max(80),
  department: z.enum(['Support', 'Development', 'UI/UX', 'Motion Graphics', 'Marketing']),
});

@Roles('ADMIN')
@Controller('api/admin')
export class AdminController {
  constructor(
    private readonly githubApp: GithubAppClient,
    @InjectDb() private readonly db: Db,
    @InjectEnv() private readonly env: Env,
    private readonly identities: IdentityService,
    @InjectQueue(NORMALIZE_QUEUE) private readonly normalize: Queue,
    @InjectQueue(BACKFILL_QUEUE) private readonly backfill: Queue,
  ) {}

  private audit(actor: AuthUser, action: string, target: string, meta: unknown = {}) {
    return this.db.execute(sql`
      INSERT INTO audit_log (id, actor_id, action, target, meta)
      VALUES (gen_random_uuid()::text, ${actor.id}, ${action}, ${target}, ${JSON.stringify(meta)}::jsonb)`);
  }

  @Post('github/sync')
  async syncGithub() { return this.githubApp.sync(); }

  @Get('health')
  async health() {
    const raw = await this.db.execute<any>(sql`
      SELECT status, count(*)::int AS n FROM raw_events WHERE received_at > now() - interval '7 days' GROUP BY status`);
    const failed = await this.db.execute<any>(sql`
      SELECT id, event_type AS "eventType", source, received_at AS "receivedAt", error, attempts
      FROM raw_events WHERE status = 'FAILED' ORDER BY received_at DESC LIMIT 25`);
    const last = await this.db.execute<any>(sql`
      SELECT max(received_at) FILTER (WHERE source = 'GITHUB') AS webhook,
             max(received_at) FILTER (WHERE source = 'GITHUB_BACKFILL') AS backfill FROM raw_events`);
    const outbox = await this.db.execute<any>(sql`SELECT count(*)::int AS n FROM outbox WHERE published_at IS NULL`);
    const repos = await this.db.execute<any>(sql`
      SELECT r.full_name AS name, max(e.occurred_at) AS "lastEventAt", count(e.id)::int AS events
      FROM repositories r LEFT JOIN events e ON e.repo_id = r.id GROUP BY r.full_name ORDER BY max(e.occurred_at) DESC NULLS LAST`);
    return {
      rawLast7Days: Object.fromEntries(raw.rows.map((r: any) => [r.status, r.n])),
      failed: failed.rows,
      lastWebhookAt: last.rows[0]?.webhook ?? null,
      lastBackfillAt: last.rows[0]?.backfill ?? null,
      outboxBacklog: outbox.rows[0].n,
      queues: {
        normalize: await this.normalize.getJobCounts('waiting', 'active', 'delayed', 'failed'),
        backfill: await this.backfill.getJobCounts('waiting', 'active', 'completed', 'failed'),
      },
      repositories: repos.rows,
      backfillAvailable: !!(this.env.GITHUB_TOKEN || this.env.GITHUB_APP_ID),
    };
  }

  @Get('identities')
  async identitiesList() {
    const r = await this.db.execute<any>(sql`
      SELECT i.external_id AS "githubId", i.handle, i.avatar_url AS "avatarUrl", i.verified_by AS "verifiedBy",
             e.id AS "employeeId", e.display_name AS "employeeName",
             (SELECT count(*) FROM events ev WHERE ev.actor_ext_id = i.external_id)::int AS events
      FROM external_identities i LEFT JOIN employees e ON e.id = i.employee_id
      WHERE i.source = 'GITHUB' AND i.handle NOT LIKE '%[bot]'
      ORDER BY (e.id IS NOT NULL), events DESC`);
    return r.rows;
  }

  @Post('identities/link')
  @HttpCode(200)
  async link(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    const { githubId, employeeId } = parseBody(LinkIdentityBody, body);
    const res = await this.identities.linkGithub(githubId, employeeId, 'ADMIN');
    await this.audit(user, 'LINK_IDENTITY', employeeId, { githubId });
    return res;
  }

  @Post('identities/unlink')
  @HttpCode(200)
  async unlink(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    const { githubId } = parseBody(z.object({ githubId: z.string().regex(/^\d+$/) }), body);
    await this.identities.unlinkGithub(githubId);
    await this.audit(user, 'UNLINK_IDENTITY', githubId);
    return { ok: true };
  }

  @Get('employees')
  async employees() {
    const r = await this.db.execute<any>(sql`
      SELECT e.id, e.display_name AS "displayName", e.email, e.role, e.active, e.team_id AS "teamId", t.name AS team,
             COALESCE(array_agg(i.handle) FILTER (WHERE i.handle IS NOT NULL), '{}') AS "githubLogins"
      FROM employees e LEFT JOIN teams t ON t.id = e.team_id
      LEFT JOIN external_identities i ON i.employee_id = e.id
      GROUP BY e.id, t.name ORDER BY e.active DESC, e.display_name`);
    const teams = await this.db.execute<any>(sql`SELECT id, name, department FROM teams ORDER BY department, name`);
    return { employees: r.rows, teams: teams.rows };
  }

  @Post('employees')
  @HttpCode(201)
  async createEmployee(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    const b = parseBody(NewEmployee, body);
    const r = await this.db.execute<{ id: string }>(sql`
      INSERT INTO employees (id, display_name, email, role, team_id)
      VALUES (gen_random_uuid()::text, ${b.displayName}, ${b.email ?? null}, ${b.role}::role, ${b.teamId ?? null})
      RETURNING id`);
    const id = r.rows[0].id;
    if (b.githubId) await this.identities.linkGithub(b.githubId, id, 'ADMIN');
    await this.audit(user, 'CREATE_EMPLOYEE', id);
    return { id };
  }

  @Post('employees/update')
  @HttpCode(200)
  async updateEmployee(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    const b = parseBody(UpdateEmployee, body);
    if (b.employeeId === user.id && b.role && b.role !== 'ADMIN') throw new BadRequestException('You cannot remove your own admin role');
    await this.db.execute(sql`
      UPDATE employees SET
        role = COALESCE(${b.role ?? null}::role, role),
        team_id = CASE WHEN ${b.teamId !== undefined} THEN ${b.teamId ?? null} ELSE team_id END,
        active = COALESCE(${b.active ?? null}::boolean, active)
      WHERE id = ${b.employeeId}`);
    if (b.active === false) await this.db.execute(sql`DELETE FROM sessions WHERE employee_id = ${b.employeeId}`);
    await this.audit(user, 'UPDATE_EMPLOYEE', b.employeeId, b);
    return { ok: true };
  }

  @Post('teams')
  @HttpCode(201)
  async createTeam(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    const b = parseBody(NewTeam, body);
    const r = await this.db.execute<{ id: string }>(sql`
      INSERT INTO teams (id, name, department) VALUES (gen_random_uuid()::text, ${b.name}, ${b.department}) RETURNING id`);
    await this.audit(user, 'CREATE_TEAM', r.rows[0].id);
    return { id: r.rows[0].id };
  }

  /** Re-runs normalization for failed raw events, e.g. after a normalizer fix. */
  @Post('replay')
  @HttpCode(200)
  async replay(@CurrentUser() user: AuthUser) {
    const r = await this.db.execute<{ id: string }>(sql`
      UPDATE raw_events SET status = 'PENDING', error = NULL WHERE status = 'FAILED' RETURNING id`);
    for (const { id } of r.rows) {
      await this.normalize.add('github', { rawId: id }, { ...normalizeJobOptions(id), jobId: `raw-${id}-replay-${Date.now()}` });
    }
    await this.audit(user, 'REPLAY', 'raw_events', { count: r.rows.length });
    return { requeued: r.rows.length };
  }

  @Post('backfill')
  @HttpCode(202)
  async startBackfill(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    if (!this.env.GITHUB_TOKEN && !this.env.GITHUB_APP_ID) throw new BadRequestException('Set GITHUB_TOKEN on the server to enable backfill');
    const b = parseBody(BackfillBody, body);
    const job = await this.backfill.add('repo', b, { attempts: 2, removeOnComplete: 50, removeOnFail: 50 });
    await this.audit(user, 'BACKFILL', b.repo, b);
    return { jobId: job.id };
  }
}
