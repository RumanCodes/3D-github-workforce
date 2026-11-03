import { Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { type Db, InjectDb } from '../infra/infra.module';

@Injectable()
export class IdentityService {
  constructor(@InjectDb() private readonly db: Db) {}

  /**
   * Links a GitHub account to an employee and re-attributes all history recorded before the link.
   * Events keep actor_ext_id precisely so this backfill is possible.
   */
  async linkGithub(githubId: string, employeeId: string, verifiedBy: 'ADMIN' | 'OAUTH', handle?: string, avatarUrl?: string | null) {
    return this.db.transaction(async (tx) => {
      const emp = await tx.execute(sql`SELECT id FROM employees WHERE id = ${employeeId}`);
      if (!emp.rows.length) throw new NotFoundException('Employee not found');
      await tx.execute(sql`
        INSERT INTO external_identities (id, employee_id, source, external_id, handle, avatar_url, verified_by)
        VALUES (gen_random_uuid()::text, ${employeeId}, 'GITHUB', ${githubId}, ${handle ?? githubId}, ${avatarUrl ?? null}, ${verifiedBy})
        ON CONFLICT (source, external_id) DO UPDATE
          SET employee_id = EXCLUDED.employee_id, verified_by = EXCLUDED.verified_by,
              handle = CASE WHEN ${handle ?? null}::text IS NULL THEN external_identities.handle ELSE EXCLUDED.handle END,
              avatar_url = COALESCE(EXCLUDED.avatar_url, external_identities.avatar_url)`);
      const ev = await tx.execute(sql`UPDATE events SET actor_id = ${employeeId} WHERE actor_ext_id = ${githubId}`);
      await tx.execute(sql`UPDATE pull_requests SET author_id = ${employeeId} WHERE author_ext_id = ${githubId}`);
      await tx.execute(sql`UPDATE reviews SET reviewer_id = ${employeeId} WHERE reviewer_ext_id = ${githubId}`);
      await tx.execute(sql`
        UPDATE employees SET avatar_url = COALESCE(employees.avatar_url, i.avatar_url)
        FROM external_identities i WHERE i.employee_id = employees.id AND employees.id = ${employeeId} AND i.external_id = ${githubId}`);
      return { reattributedEvents: ev.rowCount ?? 0 };
    });
  }

  async unlinkGithub(githubId: string) {
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`UPDATE external_identities SET employee_id = NULL, verified_by = NULL WHERE source = 'GITHUB' AND external_id = ${githubId}`);
      await tx.execute(sql`UPDATE events SET actor_id = NULL WHERE actor_ext_id = ${githubId}`);
      await tx.execute(sql`UPDATE pull_requests SET author_id = NULL WHERE author_ext_id = ${githubId}`);
      await tx.execute(sql`UPDATE reviews SET reviewer_id = NULL WHERE reviewer_ext_id = ${githubId}`);
    });
  }
}
