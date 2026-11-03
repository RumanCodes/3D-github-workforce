import { Body, Controller, Get, Post } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { Roles } from '../auth/auth.guard';
import { parseBody } from '../common/zod';
import { agentDtos, feedEvents } from '../dto';
import { type Db, InjectDb } from '../infra/infra.module';

@Controller('api/office')
export class OfficeController {
  constructor(@InjectDb() private readonly db: Db) {}
  @Get('snapshot')
  async snapshot() {
    return this.db.transaction(async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`);
      const cursor = (await tx.execute<any>(sql`SELECT coalesce(max(id),0) AS seq FROM outbox`)).rows[0];
      const [agents, feed] = await Promise.all([agentDtos(tx, sql`e.active = true`, new Date()), feedEvents(tx, sql`true`, 120)]);
      return { agents, feed, cursor: Number(cursor.seq) };
    });
  }
  @Get('layout')
  async layout() {
    const desks = await this.db.transaction(async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('workforce-seating'))`);
      await tx.execute(sql`INSERT INTO office_desks(employee_id) SELECT e.id FROM employees e WHERE e.active AND NOT EXISTS (SELECT 1 FROM office_desks d WHERE d.employee_id=e.id) ORDER BY e.team_id, e.created_at, e.id ON CONFLICT DO NOTHING`);
      const changed = (await tx.execute<any>(sql`SELECT d.employee_id,e.team_id FROM office_desks d JOIN employees e ON e.id=d.employee_id WHERE e.active AND (d.team_slot IS NULL OR d.team_id IS DISTINCT FROM e.team_id) ORDER BY d.seat`)).rows;
      for (const person of changed) {
        const slot = (await tx.execute<any>(sql`SELECT coalesce(max(team_slot)+1,0) AS slot FROM office_desks WHERE team_id IS NOT DISTINCT FROM ${person.team_id}`)).rows[0].slot;
        await tx.execute(sql`UPDATE office_desks SET team_id=${person.team_id}, team_slot=${slot} WHERE employee_id=${person.employee_id}`);
      }
      return (await tx.execute<any>(sql`SELECT d.employee_id AS "employeeId",d.seat,coalesce(t.office_zone,0) AS zone,d.team_slot AS slot FROM office_desks d JOIN employees e ON e.id=d.employee_id LEFT JOIN teams t ON t.id=d.team_id WHERE e.active`)).rows;
    });
    const products = (await this.db.execute<any>(sql`SELECT p.id, p.name,
      (SELECT count(*)::int FROM pull_requests pr JOIN repositories rr ON rr.id=pr.repo_id WHERE rr.product_id=p.id AND rr.connected AND pr.state='OPEN') AS "openPrs",
      (SELECT count(*)::int FROM pull_requests pr JOIN repositories rr ON rr.id=pr.repo_id WHERE rr.product_id=p.id AND rr.connected AND pr.state='OPEN' AND NOT pr.draft AND pr.first_review_at IS NULL) AS "awaitingReview",
      (SELECT count(*)::int FROM (SELECT DISTINCT ON(c.repo_id,c.workflow_name,c.head_branch) c.conclusion FROM ci_runs c JOIN repositories rr ON rr.id=c.repo_id WHERE rr.product_id=p.id AND rr.connected ORDER BY c.repo_id,c.workflow_name,c.head_branch,c.started_at DESC,c.attempt DESC) latest WHERE latest.conclusion='failure') AS "failingCi",
      (SELECT ev.summary FROM events ev JOIN repositories rr ON rr.id=ev.repo_id WHERE rr.product_id=p.id AND rr.connected AND ev.verb='release.published' ORDER BY ev.occurred_at DESC LIMIT 1) AS "latestRelease",
      coalesce(json_agg(r.full_name) FILTER (WHERE r.id IS NOT NULL AND r.connected), '[]') AS repositories FROM products p LEFT JOIN repositories r ON r.product_id=p.id GROUP BY p.id ORDER BY p.name`)).rows;
    const repositories = (await this.db.execute<any>(sql`SELECT id, full_name AS name, product_id AS "productId", connected, poll_cursor AS "lastPolledAt", poll_error AS "pollError" FROM repositories ORDER BY full_name`)).rows;
    return { desks, products, repositories };
  }
  @Roles('ADMIN')
  @Post('products')
  async product(@Body() body: unknown) {
    const b = parseBody(z.object({ name: z.string().trim().min(1).max(100), repositories: z.array(z.string()).max(500) }), body);
    return this.db.transaction(async tx => {
      const p = (await tx.execute<any>(sql`INSERT INTO products(name) VALUES (${b.name}) ON CONFLICT(name) DO UPDATE SET name=excluded.name RETURNING id`)).rows[0];
      await tx.execute(sql`UPDATE repositories SET product_id=NULL WHERE product_id=${p.id}`);
      for (const id of b.repositories) await tx.execute(sql`UPDATE repositories SET product_id=${p.id} WHERE id=${id}`);
      return p;
    });
  }
}
