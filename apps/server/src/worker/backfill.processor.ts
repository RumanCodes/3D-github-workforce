import { sql } from 'drizzle-orm';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { GithubAppClient } from '../github/app-client';
import { GithubClient, runBackfill } from '../github/backfill';
import { type Db, type Env, InjectDb, InjectEnv } from '../infra/infra.module';
import { BACKFILL_QUEUE } from '../infra/queues';

@Processor(BACKFILL_QUEUE, { concurrency: 1 })
export class BackfillProcessor extends WorkerHost {
  private readonly log = new Logger('Backfill');

  constructor(
    private readonly githubApp: GithubAppClient,
    @InjectDb() private readonly db: Db,
    @InjectEnv() private readonly env: Env,
  ) {
    super();
  }

  async process(job: Job<{ repo: string; days: number }>) {
    const token = await this.githubApp.forRepository(job.data.repo);
    if (!token) throw new Error('GitHub credentials are not configured');
    const client = new GithubClient(() => this.githubApp.forRepository(job.data.repo), (m) => this.log.log(m));
    const started = new Date();
    const polling = job.name === 'poll';
    const row = polling ? (await this.db.execute<any>(sql`SELECT poll_cursor FROM repositories WHERE full_name=${job.data.repo} AND connected`)).rows[0] : null;
    if (polling && !row) return { skipped: true };
    const since = row?.poll_cursor ? new Date(new Date(row.poll_cursor).getTime() - 120000) : new Date(started.getTime() - 86400000);
    try {
    const result = await runBackfill(this.db, client, job.data.repo, job.data.days, (m) => {
      this.log.log(m);
      void job.log(m);
    }, polling ? { since, live: !!row?.poll_cursor } : {});
    if (polling) await this.db.execute(sql`UPDATE repositories SET poll_cursor=${started},poll_error=NULL WHERE full_name=${job.data.repo}`);
    return result;
    } catch (error) {
      if (polling) await this.db.execute(sql`UPDATE repositories SET poll_error=${error instanceof Error ? error.message.slice(0,300) : 'GitHub sync failed'} WHERE full_name=${job.data.repo}`);
      throw error;
    }
  }
}
