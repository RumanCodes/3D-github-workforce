import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Interval } from '@nestjs/schedule';
import type { Queue } from 'bullmq';
import { type Db, type Env, InjectDb, InjectEnv } from '../infra/infra.module';
import { BACKFILL_QUEUE } from '../infra/queues';
import { sql } from 'drizzle-orm';

@Injectable()
export class PollScheduler {
  private readonly log = new Logger('GithubPolling');
  constructor(@InjectDb() private readonly db: Db, @InjectEnv() private readonly env: Env, @InjectQueue(BACKFILL_QUEUE) private readonly queue: Queue) {}
  @Interval(60000)
  async tick() {
    if (!this.env.GITHUB_POLL_ENABLED || !(this.env.GITHUB_APP_ID || this.env.GITHUB_TOKEN)) return;
    try {
      const rows = (await this.db.execute<{ id: string; full_name: string }>(sql`SELECT id,full_name FROM repositories WHERE connected AND lower(split_part(full_name,'/',1))=lower(${this.env.GITHUB_ORG}) ORDER BY poll_cursor NULLS FIRST`)).rows;
      for (const repo of rows) await this.queue.add('poll', { repo: repo.full_name, days: 1 }, {
        jobId: `poll-${repo.id}`, attempts: 3, backoff: { type: 'exponential', delay: 30000 }, removeOnComplete: true, removeOnFail: true,
      });
    } catch (error) { this.log.warn(`Could not schedule GitHub polling: ${String(error)}`); }
  }
}
