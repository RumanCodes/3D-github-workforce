/** Production migration entry point: `node dist/migrate.js` (used by the compose "migrate" service). */
import path from 'node:path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { loadEnv } from './config/env';
import { createDb } from './db/db';

async function main() {
  const env = loadEnv();
  const { db, pool } = createDb(env.DATABASE_URL, 1);
  await migrate(db, { migrationsFolder: path.join(__dirname, '..', 'drizzle') });
  await pool.end();
  console.log('Migrations applied.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
