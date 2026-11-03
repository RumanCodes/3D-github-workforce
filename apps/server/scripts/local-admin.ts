import { sql } from 'drizzle-orm';
import { loadEnv } from '../src/config/env';
import { createDb } from '../src/db/db';
async function main() {
 const env = loadEnv();
 if (!env.DEV_AUTH || env.NODE_ENV === 'production') throw new Error('Local administrator setup requires development sign-in');
 const login = env.BOOTSTRAP_ADMIN_LOGINS.split(',')[0]?.trim();
 if (!login) throw new Error('Set BOOTSTRAP_ADMIN_LOGINS first');
 const { db, pool } = createDb(env.DATABASE_URL, 1);
 try {
  await db.transaction(async tx => {
   await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('workforce-local-bootstrap'))`);
   // This is a local login, not a verified GitHub identity. OAuth linking happens separately.
   const existing = (await tx.execute(sql`SELECT id FROM employees WHERE display_name=${login}`)).rows;
   if (!existing.length) await tx.execute(sql`INSERT INTO employees(id, display_name, role) VALUES(gen_random_uuid()::text,${login},'ADMIN')`);
  });
  console.log(`Local administrator prepared. Select ${login} at http://localhost:3000/login. No GitHub identity has been verified or linked.`);
 } finally { await pool.end(); }
}
main().catch(error => { console.error(error.message); process.exitCode=1; });
