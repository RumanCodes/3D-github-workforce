import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { sql } from 'drizzle-orm';
import { type Db, InjectDb } from '../infra/infra.module';
import { NORMALIZE_QUEUE } from '../infra/queues';
import { PermanentError, processRawEvent } from '../ingestion/process-raw-event';

@Processor(NORMALIZE_QUEUE, { concurrency: 8 })
export class NormalizeProcessor extends WorkerHost {
  private readonly log = new Logger('Normalize');

  constructor(@InjectDb() private readonly db: Db) {
    super();
  }

  async process(job: Job<{ rawId: string }>) {
    try {
      return await processRawEvent(this.db, job.data.rawId);
    } catch (err) {
      if (err instanceof PermanentError) {
        job.discard();
      }
      throw err;
    }
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job<{ rawId: string }>, err: Error) {
    const final = job.attemptsMade >= (job.opts.attempts ?? 1);
    this.log.warn(`raw ${job.data.rawId} attempt ${job.attemptsMade} failed: ${err.message}`);
    if (final) {
      await this.db.execute(sql`
        UPDATE raw_events SET status = 'FAILED', error = ${err.message.slice(0, 2000)}, attempts = ${job.attemptsMade}
        WHERE id = ${job.data.rawId} AND status = 'PENDING'`);
    }
  }
}
