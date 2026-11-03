import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import type { Queue } from 'bullmq';
import { sql } from 'drizzle-orm';
import type Redis from 'ioredis';
import { type Db, InjectDb, REDIS_PUB } from '../infra/infra.module';
import { NORMALIZE_QUEUE, normalizeJobOptions } from '../infra/queues';

export const rtChannel = () => `${process.env.REDIS_PREFIX ?? 'workforce'}:rt`;

/**
 * Transactional outbox → Redis pub/sub. Rows are written in the same transaction as the event,
 * so the UI never sees an update that was rolled back, and never misses one that committed.
 */
@Injectable()
export class OutboxRelay {
  private readonly log = new Logger('OutboxRelay');
  private busy = false;

  constructor(
    @InjectDb() private readonly db: Db,
    @Inject(REDIS_PUB) private readonly redis: Redis,
    @InjectQueue(NORMALIZE_QUEUE) private readonly queue: Queue,
  ) {}

  @Interval(250)
  async flush() {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('workforce-outbox-relay'))`);
        const rows = (
          await tx.execute<{ id: string; topic: string; payload: any }>(sql`
            SELECT id, topic, payload FROM outbox WHERE published_at IS NULL
            ORDER BY id LIMIT 500 FOR UPDATE SKIP LOCKED`)
        ).rows;
        if (!rows.length) return;
        const pipe = this.redis.pipeline();
        for (const r of rows) {
          pipe.publish(rtChannel(), JSON.stringify({ topic: r.topic, msg: { ...r.payload, seq: Number(r.id) } }));
        }
        const published = await pipe.exec();
        if (!published || published.some(([error]) => error)) throw new Error('Realtime publish failed; outbox retained for retry');
        const ids = rows.map((r) => Number(r.id));
        await tx.execute(sql`UPDATE outbox SET published_at = now() WHERE id = ANY(ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb)::bigint))`);
      });
    } catch (err) {
      this.log.error(`flush failed: ${err}`);
    } finally {
      this.busy = false;
    }
  }

  /** Safety net: anything stored but never enqueued (e.g. Redis was down) gets picked up. */
  @Interval(60_000)
  async sweepPending() {
    const rows = (
      await this.db.execute<{ id: string }>(sql`
        SELECT id FROM raw_events WHERE status = 'PENDING' AND received_at < now() - interval '2 minutes'
        ORDER BY received_at LIMIT 500`)
    ).rows;
    for (const r of rows) await this.queue.add('github', { rawId: r.id }, normalizeJobOptions(r.id));
    if (rows.length) this.log.log(`re-enqueued ${rows.length} pending raw events`);
  }

  /** Published outbox rows are only needed for reconnect replay (5 minutes). */
  @Interval(10 * 60_000)
  async prune() {
    await this.db.execute(sql`DELETE FROM outbox WHERE published_at < now() - interval '1 hour'`);
    await this.db.execute(sql`DELETE FROM sessions WHERE expires_at < now()`);
  }
}
