import { sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/db';

/**
 * Idempotent raw insert. A redelivery hits the unique (source, external_event_id) and returns null,
 * so nothing is enqueued twice.
 */
export async function insertRawIfNew(
  db: DbOrTx,
  data: { source: string; externalEventId: string; eventType: string; payload: unknown },
): Promise<string | null> {
  const r = await db.execute<{ id: string }>(sql`
    INSERT INTO raw_events (id, source, external_event_id, event_type, payload)
    VALUES (gen_random_uuid()::text, ${data.source}, ${data.externalEventId}, ${data.eventType},
            ${JSON.stringify(data.payload)}::jsonb)
    ON CONFLICT (source, external_event_id) DO NOTHING
    RETURNING id`);
  return r.rows[0]?.id ?? null;
}
