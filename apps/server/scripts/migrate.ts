import { migrate } from 'drizzle-orm/node-postgres/migrator';
import path from 'node:path';
import { createDb } from '../src/db/db';
import { loadEnv } from '../src/config/env';

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
