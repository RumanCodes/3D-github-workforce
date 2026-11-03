import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import * as schema from '../src/db/schema';
import fs from 'node:fs';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { createDb, type Db } from '../src/db/db';
import { processRawEvent } from '../src/ingestion/process-raw-event';
import { insertRawIfNew } from '../src/ingestion/raw-store';

const ready = new WeakMap<object, Promise<unknown>>();
export function testDb() {
  if(process.env.WORKFORCE_TEST_MEMORY === 'true') {
    const client = new PGlite();
    const db = drizzle(client, {schema}) as unknown as Db;
    const migration = (async()=>{for(const name of fs.readdirSync(path.join(__dirname,'../drizzle')).filter(n=>n.endsWith('.sql')).sort()) await client.exec(fs.readFileSync(path.join(__dirname,'../drizzle',name),'utf8'));})();
    ready.set(db,migration);
    return {db, pool:{end:async()=>{await migration;await client.close();}}};
  }
  return createDb(process.env.DATABASE_URL!, 4);
}

export async function resetDb(db: Db) {
  await ready.get(db);
  await db.execute(sql`TRUNCATE products, github_installations, office_desks, outbox, audit_log, agent_states, reviews, ci_runs, pull_requests, events, raw_events,
    sessions, external_identities, repositories, employees, teams RESTART IDENTITY CASCADE`);
}

let seq = 0;
/** Stores a payload as a raw event and processes it, like the webhook controller + worker do. */
export async function ingest(
  db: Db,
  e: { eventType: string; payload: unknown },
  opts: { source?: 'GITHUB' | 'GITHUB_BACKFILL'; deliveryId?: string; now?: Date } = {},
) {
  const rawId = await insertRawIfNew(db, {
    source: opts.source ?? 'GITHUB',
    externalEventId: opts.deliveryId ?? `delivery-${++seq}-${Date.now()}`,
    eventType: e.eventType,
    payload: e.payload,
  });
  if (!rawId) return null;
  return processRawEvent(db, rawId, opts.now ?? new Date());
}

export async function one<T = any>(db: Db, q: ReturnType<typeof sql>): Promise<T> {
  return (await db.execute<any>(q)).rows[0];
}
