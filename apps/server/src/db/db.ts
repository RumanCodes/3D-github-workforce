import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';

export type Db = NodePgDatabase<typeof schema>;
/** Either the root db or a transaction handle; both expose the same query API. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type DbOrTx = Db | Tx;

export function createDb(url: string, max = 10): { db: Db; pool: Pool } {
  const pool = new Pool({ connectionString: url, max, options: '-c timezone=UTC' });
  return { db: drizzle(pool, { schema }), pool };
}

export { schema };

/** Postgres text[] / int[] from a JS array (drizzle would otherwise expand arrays into a parameter list). */
export const textArray = (a: string[]) => sql`ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(a)}::jsonb))::text[]`;
export const intArray = (a: number[]) => sql`ARRAY(SELECT (jsonb_array_elements_text(${JSON.stringify(a)}::jsonb))::int)::int[]`;
