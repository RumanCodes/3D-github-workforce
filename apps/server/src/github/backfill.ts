/**
 * Backfill: reads recent history from the GitHub REST API and feeds it through the SAME pipeline as
 * webhooks, wrapped to look like webhook payloads. Semantic dedupe keys mean it can be re-run safely
 * and overlaps with live webhooks collapse. Backfilled events are labeled POLLED, not VERIFIED.
 */
import type { Db } from '../db/db';
import { processRawEvent } from '../ingestion/process-raw-event';
import { insertRawIfNew } from '../ingestion/raw-store';

type Log = (msg: string) => void;

export class GithubClient {
  constructor(
    private readonly token: string | (() => Promise<string>),
    private readonly log: Log = () => {},
  ) {}

  async get<T>(path: string): Promise<{ data: T; next: string | null }> {
    const url = path.startsWith('http') ? path : `https://api.github.com${path}`;
    for (let attempt = 0; ; attempt++) {
      if (new URL(url).origin !== 'https://api.github.com') throw new Error('Unexpected GitHub pagination origin');
      const res = await fetch(url, {
        signal: AbortSignal.timeout(30000),
        headers: {
          Authorization: `Bearer ${typeof this.token === 'function' ? await this.token() : this.token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'live-workforce',
        },
      });
      const remaining = Number(res.headers.get('x-ratelimit-remaining') ?? '1000');
      const reset = Number(res.headers.get('x-ratelimit-reset') ?? '0') * 1000;
      if ((res.status === 429 || (res.status === 403 && (remaining === 0 || res.headers.has('retry-after')))) && attempt < 5) {
        const retryAfter = Number(res.headers.get('retry-after') ?? '0') * 1000;
        const wait = retryAfter || Math.max(1000, reset - Date.now()) || 60_000;
        this.log(`rate limited; waiting ${Math.round(wait / 1000)}s`);
        await new Promise((r) => setTimeout(r, Math.min(wait, 15 * 60_000)));
        continue;
      }
      if (!res.ok) throw new Error(`GitHub ${res.status} for ${path}: ${(await res.text()).slice(0, 200)}`);
      // Leave headroom for other users of the same token.
      if (remaining < 50 && reset > Date.now()) {
        this.log(`rate limit low (${remaining}); pausing until reset`);
        await new Promise((r) => setTimeout(r, Math.min(reset - Date.now() + 1000, 15 * 60_000)));
      }
      const link = res.headers.get('link') ?? '';
      const next = /<([^>]+)>;\s*rel="next"/.exec(link)?.[1] ?? null;
      return { data: (await res.json()) as T, next };
    }
  }
}

export type BackfillResult = { pullRequests: number; reviews: number; ciRuns: number; newEvents: number };

export async function runBackfill(
  db: Db,
  client: GithubClient,
  fullName: string,
  days: number,
  log: Log = () => {},
  options: { since?: Date; live?: boolean } = {},
): Promise<BackfillResult> {
  const since = options.since ?? new Date(Date.now() - days * 86_400_000);
  const repo = (await client.get<any>(`/repos/${fullName}`)).data;
  const result: BackfillResult = { pullRequests: 0, reviews: 0, ciRuns: 0, newEvents: 0 };

  const feed = async (eventType: string, payload: any, id: string) => {
    const rawId = await insertRawIfNew(db, { source: options.live ? 'GITHUB_POLL' : 'GITHUB_BACKFILL', externalEventId: id, eventType, payload });
    if (rawId) result.newEvents += (await processRawEvent(db, rawId)).inserted;
  };

  // Pull requests, newest-updated first, until we pass the window.
  let next: string | null = `/repos/${fullName}/pulls?state=all&sort=updated&direction=desc&per_page=100`;
  outer: while (next) {
    const page: { data: any[]; next: string | null } = await client.get<any[]>(next);
    for (const listed of page.data) {
      if (new Date(listed.updated_at) < since) break outer;
      const pr = (await client.get<any>(`/repos/${fullName}/pulls/${listed.number}`)).data;
      const base = { repository: repo, sender: pr.user, number: pr.number };
      await feed('pull_request', { ...base, action: 'opened', pull_request: pr }, `bf:pr.opened:${pr.id}:${pr.updated_at}`);
      await feed('pull_request', { ...base, action: 'edited', pull_request: pr }, `bf:pr.updated:${pr.id}:${pr.updated_at}`);
      if (pr.merged_at) {
        await feed('pull_request', { ...base, action: 'closed', pull_request: pr, sender: pr.merged_by ?? pr.user }, `bf:pr.closed:${pr.id}:${pr.updated_at}`);
      } else if (pr.state === 'closed') {
        await feed('pull_request', { ...base, action: 'closed', pull_request: pr }, `bf:pr.closed:${pr.id}:${pr.updated_at}`);
      }
      result.pullRequests++;

      let rNext: string | null = `/repos/${fullName}/pulls/${pr.number}/reviews?per_page=100`;
      while (rNext) {
        const rp: { data: any[]; next: string | null } = await client.get<any[]>(rNext);
        for (const review of rp.data) {
          if (!review.submitted_at || !review.user) continue;
          await feed(
            'pull_request_review',
            { action: 'submitted', review, pull_request: pr, repository: repo, sender: review.user },
            `bf:review:${review.id}`,
          );
          result.reviews++;
        }
        rNext = rp.next;
      }
    }
    next = page.next;
  }
  log(`${fullName}: ${result.pullRequests} PRs, ${result.reviews} reviews`);

  let commentNext: string | null = `/repos/${fullName}/pulls/comments?sort=updated&direction=desc&since=${since.toISOString()}&per_page=100`;
  while (commentNext) {
    const page: { data: any[]; next: string | null } = await client.get<any[]>(commentNext);
    for (const comment of page.data) {
      const number = Number(comment.pull_request_url?.split('/').pop());
      if (!Number.isSafeInteger(number) || number <= 0) continue;
      const pr = (await client.get<any>(`/repos/${fullName}/pulls/${number}`)).data;
      await feed('pull_request_review_comment', { action:'created', comment, pull_request:pr, repository:repo, sender:comment.user }, `bf:comment:${comment.id}`);
    }
    commentNext = page.next;
  }
  // Repository events provide push actors; commits alone do not identify who pushed.
  const eventSince = new Date(Math.min(since.getTime(), Date.now() - 86400000));
  let eventNext: string | null = `/repos/${fullName}/events?per_page=100`;
  while (eventNext) {
    const page: { data: any[]; next: string | null } = await client.get<any[]>(eventNext);
    for (const event of page.data) {
      if (new Date(event.created_at) < eventSince || event.type !== 'PushEvent') continue;
      const payload = event.payload;
      if (!payload.head || /^0+$/.test(payload.head)) continue;
      await feed('push', { ref:payload.ref, after:payload.head, commits:payload.commits ?? [{}], workforce_push_count_unknown: !payload.commits, head_commit:{timestamp:event.created_at}, compare:`https://github.com/${fullName}/commit/${payload.head}`, repository:repo, sender:event.actor }, `bf:push:${event.id}`);
    }
    // GitHub's repository event stream is bounded; never promise complete historical push recovery.
    eventNext = page.data.some(e => new Date(e.created_at) < eventSince) ? null : page.next;
  }
  // Workflow runs in the window.
  let wNext: string | null = `/repos/${fullName}/actions/runs?per_page=100&created=>=${new Date(Math.min(since.getTime(), Date.now()-30*86400000)).toISOString().slice(0, 10)}`;
  while (wNext) {
    const wp: { data: { workflow_runs: any[] }; next: string | null } = await client.get<{ workflow_runs: any[] }>(wNext);
    for (const run of wp.data.workflow_runs) {
      if (run.status !== 'completed' || new Date(run.updated_at) < since) continue;
      await feed(
        'workflow_run',
        { action: 'completed', workflow_run: run, repository: repo, sender: run.triggering_actor ?? run.actor },
        `bf:run:${run.id}:${run.run_attempt ?? 1}`,
      );
      result.ciRuns++;
    }
    wNext = wp.next;
  }
  // Issues are also returned for PRs; skip those to avoid attributing PR work twice.
  let iNext: string | null = `/repos/${fullName}/issues?state=all&sort=updated&direction=desc&per_page=100&since=${since.toISOString()}`;
  while (iNext) {
    const page: { data: any[]; next: string | null } = await client.get<any[]>(iNext);
    for (const issue of page.data) {
      if (issue.pull_request) continue;
      if (new Date(issue.created_at) >= since) await feed('issues', { action: 'opened', issue, repository: repo, sender: issue.user }, `bf:issue.opened:${issue.id}`);
      if (issue.closed_at && new Date(issue.closed_at) >= since && !issue.closed_by) issue.closed_by = (await client.get<any>(`/repos/${fullName}/issues/${issue.number}`)).data.closed_by;
      if (issue.closed_at && new Date(issue.closed_at) >= since && issue.closed_by) await feed('issues', { action: 'closed', issue, repository: repo, sender: issue.closed_by }, `bf:issue.closed:${issue.id}:${issue.closed_at}`);
    }
    iNext = page.next;
  }
  let releaseNext: string | null = `/repos/${fullName}/releases?per_page=100`;
  while (releaseNext) {
    const page: { data: any[]; next: string | null } = await client.get<any[]>(releaseNext);
    for (const release of page.data) if (!release.draft && release.published_at && new Date(release.published_at) >= since) await feed('release', { action: 'published', release, repository: repo, sender: release.author }, `bf:release:${release.id}`);
    releaseNext = page.next;
  }
  log(`${fullName}: ${result.ciRuns} CI runs, ${result.newEvents} new events`);
  return result;
}
