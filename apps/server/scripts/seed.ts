/**
 * Sample organization for local development: teams, employees and their linked GitHub identities.
 * Safe to re-run. In production, people are created by GitHub sign-in or by an admin.
 */
import { sql } from 'drizzle-orm';
import { loadEnv } from '../src/config/env';
import { createDb } from '../src/db/db';
import { DEMO_PEOPLE, DEMO_TEAMS } from './lib/demo-org';

async function main() {
  const env = loadEnv();
  const { db, pool } = createDb(env.DATABASE_URL, 2);
  for (const t of DEMO_TEAMS) {
    await db.execute(sql`INSERT INTO teams (id, name, department) VALUES (${t.id}, ${t.name}, ${t.department}) ON CONFLICT (id) DO NOTHING`);
  }
  for (const p of DEMO_PEOPLE) {
    if (!p.employee) continue;
    const avatar = null; // sample people get initials, not someone's real GitHub photo
    await db.execute(sql`
      INSERT INTO employees (id, display_name, email, role, team_id)
      VALUES (${p.employee.id}, ${p.employee.name}, ${p.employee.email}, ${p.employee.role}::role, ${p.employee.teamId})
      ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name, role = EXCLUDED.role, team_id = EXCLUDED.team_id`);
    await db.execute(sql`
      INSERT INTO external_identities (id, employee_id, source, external_id, handle, avatar_url, verified_by)
      VALUES (gen_random_uuid()::text, ${p.employee.id}, 'GITHUB', ${String(p.gh.id)}, ${p.gh.login}, ${avatar}, 'ADMIN')
      ON CONFLICT (source, external_id) DO UPDATE SET employee_id = EXCLUDED.employee_id`);
  }
  console.log(`Seeded ${DEMO_TEAMS.length} teams and ${DEMO_PEOPLE.filter((p) => p.employee).length} employees.`);
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
