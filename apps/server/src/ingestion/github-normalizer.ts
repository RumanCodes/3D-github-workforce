/**
 * Turns a raw GitHub webhook (or a backfilled REST object wrapped to look like one) into canonical events.
 *
 * Pure function: no I/O. Every event gets a *semantic* dedupe key, so the same fact delivered twice,
 * or delivered once by webhook and once by backfill, is stored exactly once.
 */
import { z } from 'zod';

// ---------- Minimal validation of the untrusted payload fields we rely on ----------

const User = z.object({ id: z.number(), login: z.string(), avatar_url: z.string().nullish(), type: z.string().nullish() });
const Repo = z.object({
  id: z.number(),
  full_name: z.string(),
  private: z.boolean().nullish(),
  default_branch: z.string().nullish(),
});
const PullRequest = z.object({
  id: z.number().nullish(),
  number: z.number(),
  title: z.string(),
  html_url: z.string(),
  user: User,
  state: z.enum(['open', 'closed']),
  draft: z.boolean().nullish(),
  merged: z.boolean().nullish(),
  merged_at: z.string().nullish(),
  merged_by: User.nullish(),
  closed_at: z.string().nullish(),
  created_at: z.string(),
  updated_at: z.string(),
  additions: z.number().nullish(),
  deletions: z.number().nullish(),
  head: z.object({ sha: z.string(), ref: z.string().nullish() }),
  requested_reviewers: z.array(User).nullish(),
});
const Review = z.object({
  id: z.number(),
  user: User,
  state: z.string(),
  submitted_at: z.string().nullish(),
  html_url: z.string().nullish(),
});
const WorkflowRun = z.object({
  id: z.number(),
  name: z.string().nullish(),
  run_attempt: z.number().nullish(),
  head_sha: z.string(),
  head_branch: z.string().nullish(),
  event: z.string().nullish(),
  status: z.string().nullish(),
  conclusion: z.string().nullish(),
  html_url: z.string(),
  run_started_at: z.string().nullish(),
  created_at: z.string(),
  updated_at: z.string(),
  triggering_actor: User.nullish(),
  actor: User.nullish(),
  pull_requests: z.array(z.object({ number: z.number() })).nullish(),
});

export type RepoFacts = { githubId: number; fullName: string; private: boolean; defaultBranch: string };
export type ActorFacts = { extId: string; login: string; avatarUrl: string | null; isBot: boolean };

export type PrFacts = {
  number: number;
  githubId: number | null;
  title: string;
  url: string;
  author: ActorFacts;
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  draft: boolean;
  headSha: string;
  additions: number | null; // null when the payload omits it (review events carry a simplified PR)
  deletions: number | null;
  createdAt: Date;
  updatedAt: Date;
  mergedAt: Date | null;
  closedAt: Date | null;
  mergedByExtId: string | null;
  requestedReviewers: string[] | null; // null = unknown in this payload
  /** Full snapshots may change state; partial ones (from review events) only fill gaps. */
  full: boolean;
};

export type Projection =
  | { kind: 'pr'; pr: PrFacts; readyAt?: Date }
  | {
      kind: 'review';
      pr: PrFacts;
      review: { githubId: number; reviewer: ActorFacts; state: string; submittedAt: Date };
    }
  | { kind: 'review_dismissed'; pr: PrFacts; reviewGithubId: number }
  | {
      kind: 'ci';
      run: {
        githubId: number;
        attempt: number;
        workflowName: string;
        headSha: string;
        headBranch: string | null;
        event: string | null;
        conclusion: string | null;
        startedAt: Date;
        completedAt: Date | null;
        url: string;
        prNumbers: number[];
      };
    }
  | { kind: 'none' };

export type CanonicalEvent = {
  dedupeKey: string;
  verb: string;
  occurredAt: Date;
  actor: ActorFacts | null;
  repo: RepoFacts | null;
  subjectType: 'PR' | 'REVIEW' | 'CI_RUN' | 'PUSH' | 'RELEASE' | 'ISSUE' | 'STATUS';
  subjectId: string;
  url: string | null;
  summary: string;
  provenance: 'VERIFIED' | 'POLLED';
  data: Record<string, unknown>;
  projection: Projection;
  /** Pending/started events update projections but are not shown in the activity feed. */
  feed: boolean;
};

const toActor = (u: z.infer<typeof User>): ActorFacts => ({
  extId: String(u.id),
  login: u.login,
  avatarUrl: u.avatar_url ?? null,
  isBot: u.type === 'Bot' || u.login.endsWith('[bot]'),
});
const toRepo = (r: z.infer<typeof Repo>): RepoFacts => ({
  githubId: r.id,
  fullName: r.full_name,
  private: r.private ?? true,
  defaultBranch: r.default_branch ?? 'main',
});
const d = (s: string | null | undefined): Date | null => (s ? new Date(s) : null);

export function toPrFacts(raw: unknown, full: boolean): PrFacts {
  const pr = PullRequest.parse(raw);
  const mergedAt = d(pr.merged_at);
  return {
    number: pr.number,
    githubId: pr.id ?? null,
    title: pr.title,
    url: pr.html_url,
    author: toActor(pr.user),
    state: mergedAt || pr.merged ? 'MERGED' : pr.state === 'closed' ? 'CLOSED' : 'OPEN',
    draft: pr.draft ?? false,
    headSha: pr.head.sha,
    additions: full ? (pr.additions ?? null) : null,
    deletions: full ? (pr.deletions ?? null) : null,
    createdAt: new Date(pr.created_at),
    updatedAt: new Date(pr.updated_at),
    mergedAt,
    closedAt: d(pr.closed_at),
    mergedByExtId: pr.merged_by ? String(pr.merged_by.id) : null,
    requestedReviewers: pr.requested_reviewers ? pr.requested_reviewers.map((u) => String(u.id)) : null,
    full,
  };
}

type Input = { eventType: string; payload: any; source: 'GITHUB' | 'GITHUB_BACKFILL' | 'GITHUB_POLL' };

export function normalizeGithub({ eventType, payload, source }: Input): CanonicalEvent[] {
  const provenance = source === 'GITHUB' ? 'VERIFIED' : 'POLLED';
  const repo = payload?.repository ? toRepo(Repo.parse(payload.repository)) : null;
  const sender = payload?.sender ? toActor(User.parse(payload.sender)) : null;
  const action: string | undefined = payload?.action;
  const base = (e: Omit<CanonicalEvent, 'provenance' | 'repo' | 'feed'> & { feed?: boolean }): CanonicalEvent => ({
    provenance,
    repo,
    feed: true,
    ...e,
  });

  switch (eventType) {
    case 'pull_request': {
      if (!repo) return [];
      const pr = toPrFacts(payload.pull_request, true);
      const key = `${repo.githubId}:${pr.number}`;
      const ref = `${repo.fullName}#${pr.number}`;
      const subject = { subjectType: 'PR' as const, subjectId: key, url: pr.url };
      const proj: Projection = { kind: 'pr', pr };
      switch (action) {
        case 'opened':
          return [
            base({
              ...subject,
              dedupeKey: `gh:pr.opened:${key}`,
              verb: 'pr.opened',
              occurredAt: pr.createdAt,
              actor: pr.author,
              summary: `opened ${pr.draft ? 'draft ' : ''}${ref}: ${pr.title}`,
              data: { draft: pr.draft, additions: pr.additions, deletions: pr.deletions },
              projection: { kind: 'pr', pr, readyAt: pr.draft ? undefined : pr.createdAt },
            }),
          ];
        case 'ready_for_review':
          return [
            base({
              ...subject,
              dedupeKey: `gh:pr.ready:${key}:${pr.updatedAt.toISOString()}`,
              verb: 'pr.ready',
              occurredAt: pr.updatedAt,
              actor: sender,
              summary: `marked ${ref} ready for review`,
              data: {},
              projection: { kind: 'pr', pr, readyAt: pr.updatedAt },
            }),
          ];
        case 'converted_to_draft':
          return [
            base({
              ...subject,
              dedupeKey: `gh:pr.draft:${key}:${pr.updatedAt.toISOString()}`,
              verb: 'pr.converted_to_draft',
              occurredAt: pr.updatedAt,
              actor: sender,
              summary: `converted ${ref} back to draft`,
              data: {},
              projection: proj,
            }),
          ];
        case 'review_requested': {
          const reviewer = payload.requested_reviewer ? toActor(User.parse(payload.requested_reviewer)) : null;
          const team: string | undefined = payload.requested_team?.name;
          return [
            base({
              ...subject,
              dedupeKey: `gh:pr.review_requested:${key}:${reviewer?.extId ?? `team-${team}`}:${pr.updatedAt.toISOString()}`,
              verb: 'pr.review_requested',
              occurredAt: pr.updatedAt,
              actor: sender,
              summary: `requested review from ${reviewer ? '@' + reviewer.login : `team ${team}`} on ${ref}`,
              data: { reviewerExtId: reviewer?.extId ?? null, reviewerLogin: reviewer?.login ?? null, team: team ?? null },
              projection: proj,
            }),
          ];
        }
        case 'review_request_removed':
        case 'edited':
        case 'labeled':
        case 'unlabeled':
        case 'assigned':
        case 'unassigned':
          // Snapshot-only: keep the projection fresh, no feed noise.
          return [
            base({
              ...subject,
              dedupeKey: `gh:pr.updated:${key}:${pr.updatedAt.toISOString()}:${action}`,
              verb: 'pr.updated',
              occurredAt: pr.updatedAt,
              actor: sender,
              summary: `updated ${ref}`,
              data: { action },
              projection: proj,
              feed: false,
            }),
          ];
        case 'synchronize': {
          const after: string = payload.after ?? pr.headSha;
          return [
            base({
              ...subject,
              dedupeKey: `gh:pr.synchronized:${key}:${after}`,
              verb: 'pr.synchronized',
              occurredAt: pr.updatedAt,
              actor: sender,
              summary: `pushed new commits to ${ref}`,
              data: { after },
              projection: proj,
            }),
          ];
        }
        case 'closed':
          if (pr.state === 'MERGED') {
            return [
              base({
                ...subject,
                dedupeKey: `gh:pr.merged:${key}`,
                verb: 'pr.merged',
                occurredAt: pr.mergedAt ?? pr.updatedAt,
                actor: payload.pull_request.merged_by ? toActor(User.parse(payload.pull_request.merged_by)) : sender,
                summary: `merged ${ref}: ${pr.title}`,
                data: { authorExtId: pr.author.extId, additions: pr.additions, deletions: pr.deletions },
                projection: proj,
              }),
            ];
          }
          return [
            base({
              ...subject,
              dedupeKey: `gh:pr.closed:${key}:${(pr.closedAt ?? pr.updatedAt).toISOString()}`,
              verb: 'pr.closed',
              occurredAt: pr.closedAt ?? pr.updatedAt,
              actor: sender,
              summary: `closed ${ref} without merging`,
              data: {},
              projection: proj,
            }),
          ];
        case 'reopened':
          return [
            base({
              ...subject,
              dedupeKey: `gh:pr.reopened:${key}:${pr.updatedAt.toISOString()}`,
              verb: 'pr.reopened',
              occurredAt: pr.updatedAt,
              actor: sender,
              summary: `reopened ${ref}`,
              data: {},
              projection: proj,
            }),
          ];
        default:
          return [];
      }
    }

    case 'pull_request_review': {
      if (!repo) return [];
      const pr = toPrFacts(payload.pull_request, false);
      const review = Review.parse(payload.review);
      const key = `${repo.githubId}:${pr.number}`;
      const ref = `${repo.fullName}#${pr.number}`;
      const reviewer = toActor(review.user);
      if (action === 'submitted') {
        const state = review.state.toUpperCase();
        const submittedAt = d(review.submitted_at) ?? pr.updatedAt;
        const words: Record<string, string> = {
          APPROVED: 'approved',
          CHANGES_REQUESTED: 'requested changes on',
          COMMENTED: 'reviewed',
        };
        return [
          base({
            subjectType: 'REVIEW',
            subjectId: String(review.id),
            url: review.html_url ?? pr.url,
            dedupeKey: `gh:review.submitted:${review.id}`,
            verb: 'review.submitted',
            occurredAt: submittedAt,
            actor: reviewer,
            summary: `${words[state] ?? 'reviewed'} ${ref}`,
            data: { state, prKey: key, authorExtId: pr.author.extId },
            projection: { kind: 'review', pr, review: { githubId: review.id, reviewer, state, submittedAt } },
          }),
        ];
      }
      if (action === 'dismissed') {
        return [
          base({
            subjectType: 'REVIEW',
            subjectId: String(review.id),
            url: pr.url,
            dedupeKey: `gh:review.dismissed:${review.id}`,
            verb: 'review.dismissed',
            occurredAt: pr.updatedAt,
            actor: sender,
            summary: `dismissed a review on ${ref}`,
            data: { prKey: key },
            projection: { kind: 'review_dismissed', pr, reviewGithubId: review.id },
          }),
        ];
      }
      return [];
    }

    case 'pull_request_review_comment': {
      if (!repo || action !== 'created') return [];
      const pr = toPrFacts(payload.pull_request, false);
      const c = payload.comment;
      const ref = `${repo.fullName}#${pr.number}`;
      return [
        base({
          subjectType: 'REVIEW',
          subjectId: String(c.id),
          url: c.html_url ?? pr.url,
          dedupeKey: `gh:review.comment:${c.id}`,
          verb: 'review.commented',
          occurredAt: new Date(c.created_at),
          actor: c.user ? toActor(User.parse(c.user)) : sender,
          summary: `left a review comment on ${ref}`,
          data: { prKey: `${repo.githubId}:${pr.number}` },
          projection: { kind: 'none' },
          feed: false,
        }),
      ];
    }

    case 'workflow_run': {
      if (!repo) return [];
      const run = WorkflowRun.parse(payload.workflow_run);
      const attempt = run.run_attempt ?? 1;
      const actor = run.triggering_actor ? toActor(run.triggering_actor) : run.actor ? toActor(run.actor) : sender;
      const completed = action === 'completed';
      const name = run.name ?? 'workflow';
      const projection: Projection = {
        kind: 'ci',
        run: {
          githubId: run.id,
          attempt,
          workflowName: name,
          headSha: run.head_sha,
          headBranch: run.head_branch ?? null,
          event: run.event ?? null,
          conclusion: completed ? (run.conclusion ?? null) : null,
          startedAt: d(run.run_started_at) ?? new Date(run.created_at),
          completedAt: completed ? new Date(run.updated_at) : null,
          url: run.html_url,
          prNumbers: (run.pull_requests ?? []).map((p) => p.number),
        },
      };
      return [
        base({
          subjectType: 'CI_RUN',
          subjectId: `${run.id}:${attempt}`,
          url: run.html_url,
          dedupeKey: `gh:ci.${completed ? 'completed' : 'started'}:${run.id}:${attempt}`,
          verb: completed ? 'ci.completed' : 'ci.started',
          occurredAt: completed ? new Date(run.updated_at) : (d(run.run_started_at) ?? new Date(run.created_at)),
          actor,
          // Verb phrases, so they read naturally after a name: "Leo triggered CI, which failed on …"
          summary: completed
            ? `triggered ${name}, which ${run.conclusion === 'success' ? 'passed' : run.conclusion === 'failure' ? 'failed' : `ended (${run.conclusion ?? 'unknown'})`} on ${run.head_branch ?? run.head_sha.slice(0, 7)} in ${repo.fullName}`
            : `started ${name} on ${run.head_branch ?? run.head_sha.slice(0, 7)} in ${repo.fullName}`,
          data: { conclusion: run.conclusion ?? null, workflow: name, attempt, branch: run.head_branch ?? null },
          projection,
          feed: completed,
        }),
      ];
    }

    case 'push': {
      if (!repo || payload.deleted) return [];
      const ref: string = payload.ref ?? '';
      const branch = ref.replace('refs/heads/', '');
      const commits: number | null = source === 'GITHUB_POLL' && payload.workforce_push_count_unknown ? null : payload.workforce_push_count_unknown && source === 'GITHUB_BACKFILL' ? null : Array.isArray(payload.commits) ? payload.commits.length : 0;
      if (commits === 0) return [];
      const occurred = d(payload.head_commit?.timestamp) ?? new Date();
      return [
        base({
          subjectType: 'PUSH',
          subjectId: `${repo.githubId}:${payload.after}`,
          url: payload.compare ?? null,
          dedupeKey: `gh:push:${repo.githubId}:${payload.after}`,
          verb: 'code.pushed',
          occurredAt: occurred,
          actor: sender,
          summary: `pushed ${commits === null ? 'commits' : `${commits} commit${commits === 1 ? '' : 's'}`} to ${branch} in ${repo.fullName}`,
          data: { branch, commits, isDefault: branch === repo.defaultBranch },
          projection: { kind: 'none' },
        }),
      ];
    }

    case 'release': {
      if (!repo || action !== 'published') return [];
      const r = payload.release;
      return [
        base({
          subjectType: 'RELEASE',
          subjectId: String(r.id),
          url: r.html_url,
          dedupeKey: `gh:release.published:${r.id}`,
          verb: 'release.published',
          occurredAt: new Date(r.published_at ?? r.created_at),
          actor: r.author ? toActor(User.parse(r.author)) : sender,
          summary: `published release ${r.tag_name} of ${repo.fullName}`,
          data: { tag: r.tag_name, prerelease: !!r.prerelease },
          projection: { kind: 'none' },
        }),
      ];
    }

    case 'issues': {
      if (!repo || (action !== 'opened' && action !== 'closed' && action !== 'reopened')) return [];
      const i = payload.issue;
      const labels: string[] = (i.labels ?? []).map((l: any) => String(l.name).toLowerCase());
      const when = action === 'closed' ? (i.closed_at ?? i.updated_at) : action === 'opened' ? i.created_at : i.updated_at;
      return [
        base({
          subjectType: 'ISSUE',
          subjectId: String(i.id),
          url: i.html_url,
          dedupeKey: `gh:issue.${action}:${i.id}:${when}`,
          verb: `issue.${action}`,
          occurredAt: new Date(when),
          actor: sender,
          summary: `${action} issue ${repo.fullName}#${i.number}: ${i.title}`,
          data: { labels, isBug: labels.includes('bug') },
          projection: { kind: 'none' },
        }),
      ];
    }

    default:
      // ping, installation, check_suite, etc.: stored raw, intentionally not normalized.
      return [];
  }
}
