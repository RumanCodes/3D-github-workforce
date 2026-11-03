/**
 * Projection writers. Each runs inside the event's transaction and is written to be
 * order-independent: merges use LEAST/GREATEST/COALESCE and snapshot timestamps,
 * so events arriving late or twice converge on the same final state.
 */
import { sql } from 'drizzle-orm';
import { intArray, textArray, type Tx } from '../db/db';
import type { ActorFacts, PrFacts, RepoFacts } from './github-normalizer';

export async function upsertRepo(tx: Tx, repo: RepoFacts): Promise<string> {
  const r = await tx.execute<{ id: string }>(sql`
    INSERT INTO repositories (id, github_id, full_name, private, default_branch)
    VALUES (gen_random_uuid()::text, ${repo.githubId}, ${repo.fullName}, ${repo.private}, ${repo.defaultBranch})
    ON CONFLICT (github_id) DO UPDATE
      SET full_name = EXCLUDED.full_name, private = EXCLUDED.private, default_branch = EXCLUDED.default_branch
    RETURNING id`);
  return r.rows[0].id;
}

/** Records the GitHub account and returns the linked employee id, if any. */
export async function upsertIdentity(tx: Tx, actor: ActorFacts): Promise<string | null> {
  const r = await tx.execute<{ employee_id: string | null }>(sql`
    INSERT INTO external_identities (id, source, external_id, handle, avatar_url)
    VALUES (gen_random_uuid()::text, 'GITHUB', ${actor.extId}, ${actor.login}, ${actor.avatarUrl})
    ON CONFLICT (source, external_id) DO UPDATE
      SET handle = EXCLUDED.handle, avatar_url = COALESCE(EXCLUDED.avatar_url, external_identities.avatar_url)
    RETURNING employee_id`);
  return r.rows[0]?.employee_id ?? null;
}

export async function upsertPullRequest(
  tx: Tx,
  repoId: string,
  pr: PrFacts,
  authorId: string | null,
  occurredAt: Date,
  readyAt: Date | undefined,
): Promise<string> {
  const stateChangedAt = pr.state === 'MERGED' ? (pr.mergedAt ?? pr.updatedAt) : pr.state === 'CLOSED' ? (pr.closedAt ?? pr.updatedAt) : pr.updatedAt;
  // Partial snapshots (from review events) get the epoch so any full snapshot supersedes them.
  const snapshotAt = pr.full ? pr.updatedAt : new Date(0);
  const reviewers = pr.requestedReviewers ?? [];
  const reviewersKnown = pr.requestedReviewers !== null;
  const r = await tx.execute<{ id: string }>(sql`
    INSERT INTO pull_requests (
      id, repo_id, number, title, url, author_ext_id, author_id, state, state_changed_at, draft, head_sha,
      additions, deletions, created_at, ready_at, merged_at, closed_at, merged_by_ext_id,
      requested_reviewers, last_activity_at, snapshot_at)
    VALUES (
      gen_random_uuid()::text, ${repoId}, ${pr.number}, ${pr.title}, ${pr.url}, ${pr.author.extId}, ${authorId},
      ${pr.state}, ${stateChangedAt}, ${pr.draft}, ${pr.headSha},
      ${pr.additions ?? 0}, ${pr.deletions ?? 0}, ${pr.createdAt}, ${readyAt ?? null}, ${pr.mergedAt}, ${pr.closedAt},
      ${pr.mergedByExtId}, ${textArray(reviewers)}, ${occurredAt}, ${snapshotAt})
    ON CONFLICT (repo_id, number) DO UPDATE SET
      -- Fields that only a newer *full* snapshot may change:
      title      = CASE WHEN EXCLUDED.snapshot_at >= pull_requests.snapshot_at THEN EXCLUDED.title ELSE pull_requests.title END,
      draft      = CASE WHEN EXCLUDED.snapshot_at >= pull_requests.snapshot_at THEN EXCLUDED.draft ELSE pull_requests.draft END,
      head_sha   = CASE WHEN EXCLUDED.snapshot_at >= pull_requests.snapshot_at THEN EXCLUDED.head_sha ELSE pull_requests.head_sha END,
      additions  = CASE WHEN ${pr.additions !== null} AND EXCLUDED.snapshot_at >= pull_requests.snapshot_at THEN EXCLUDED.additions ELSE pull_requests.additions END,
      deletions  = CASE WHEN ${pr.deletions !== null} AND EXCLUDED.snapshot_at >= pull_requests.snapshot_at THEN EXCLUDED.deletions ELSE pull_requests.deletions END,
      requested_reviewers = CASE WHEN ${reviewersKnown} AND EXCLUDED.snapshot_at >= pull_requests.snapshot_at
                                 THEN EXCLUDED.requested_reviewers ELSE pull_requests.requested_reviewers END,
      -- Merged is terminal; otherwise the newest full snapshot decides OPEN/CLOSED.
      state = CASE
        WHEN pull_requests.state = 'MERGED' OR EXCLUDED.state = 'MERGED' THEN 'MERGED'::pr_state
        WHEN EXCLUDED.snapshot_at >= pull_requests.snapshot_at AND EXCLUDED.snapshot_at > 'epoch' THEN EXCLUDED.state
        ELSE pull_requests.state END,
      state_changed_at = CASE WHEN EXCLUDED.snapshot_at >= pull_requests.snapshot_at AND EXCLUDED.snapshot_at > 'epoch'
                              THEN EXCLUDED.state_changed_at ELSE pull_requests.state_changed_at END,
      closed_at = CASE WHEN EXCLUDED.snapshot_at >= pull_requests.snapshot_at AND EXCLUDED.snapshot_at > 'epoch'
                       THEN EXCLUDED.closed_at ELSE pull_requests.closed_at END,
      merged_at = COALESCE(pull_requests.merged_at, EXCLUDED.merged_at),
      merged_by_ext_id = COALESCE(pull_requests.merged_by_ext_id, EXCLUDED.merged_by_ext_id),
      ready_at = LEAST(pull_requests.ready_at, EXCLUDED.ready_at),
      author_id = COALESCE(EXCLUDED.author_id, pull_requests.author_id),
      last_activity_at = GREATEST(pull_requests.last_activity_at, EXCLUDED.last_activity_at),
      snapshot_at = GREATEST(pull_requests.snapshot_at, EXCLUDED.snapshot_at)
    RETURNING id`);
  return r.rows[0].id;
}

/** Recomputes first-review and approval times from stored reviews, so arrival order never matters. */
export async function recomputeReviewTimes(tx: Tx, prId: string): Promise<void> {
  await tx.execute(sql`
    UPDATE pull_requests p SET
      first_review_at = (SELECT MIN(r.submitted_at) FROM reviews r
                         WHERE r.pr_id = p.id AND r.reviewer_ext_id <> p.author_ext_id),
      approved_at     = (SELECT MIN(r.submitted_at) FROM reviews r
                         WHERE r.pr_id = p.id AND r.state = 'APPROVED' AND r.reviewer_ext_id <> p.author_ext_id)
    WHERE p.id = ${prId}`);
}

export async function insertReview(
  tx: Tx,
  prId: string,
  review: { githubId: number; reviewer: ActorFacts; state: string; submittedAt: Date },
  reviewerId: string | null,
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO reviews (id, github_id, pr_id, reviewer_ext_id, reviewer_id, state, submitted_at)
    VALUES (gen_random_uuid()::text, ${review.githubId}, ${prId}, ${review.reviewer.extId}, ${reviewerId},
            ${review.state}, ${review.submittedAt})
    ON CONFLICT (github_id) DO UPDATE
      SET reviewer_id = COALESCE(EXCLUDED.reviewer_id, reviews.reviewer_id),
          state = CASE WHEN reviews.state = 'DISMISSED' THEN reviews.state ELSE EXCLUDED.state END`);
  await tx.execute(sql`
    UPDATE pull_requests SET last_activity_at = GREATEST(last_activity_at, ${review.submittedAt}) WHERE id = ${prId}`);
}

export async function dismissReview(tx: Tx, reviewGithubId: number): Promise<string | null> {
  const r = await tx.execute<{ pr_id: string }>(sql`
    UPDATE reviews SET state = 'DISMISSED' WHERE github_id = ${reviewGithubId} RETURNING pr_id`);
  return r.rows[0]?.pr_id ?? null;
}

type RunFacts = {
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

/** Stores the run and returns the ids of open PRs whose CI state was recomputed. */
export async function upsertCiRun(tx: Tx, repoId: string, run: RunFacts): Promise<string[]> {
  await tx.execute(sql`
    INSERT INTO ci_runs (id, github_id, attempt, repo_id, workflow_name, head_sha, head_branch, event,
                         conclusion, started_at, completed_at, url, pr_numbers)
    VALUES (gen_random_uuid()::text, ${run.githubId}, ${run.attempt}, ${repoId}, ${run.workflowName}, ${run.headSha},
            ${run.headBranch}, ${run.event}, ${run.conclusion}, ${run.startedAt}, ${run.completedAt}, ${run.url},
            ${intArray(run.prNumbers)})
    ON CONFLICT (github_id, attempt) DO UPDATE SET
      conclusion   = COALESCE(EXCLUDED.conclusion, ci_runs.conclusion),
      completed_at = COALESCE(EXCLUDED.completed_at, ci_runs.completed_at),
      pr_numbers   = CASE WHEN cardinality(EXCLUDED.pr_numbers) > 0 THEN EXCLUDED.pr_numbers ELSE ci_runs.pr_numbers END`);

  // For each affected open PR: take the latest attempt of each workflow on the PR's head commit.
  const r = await tx.execute<{ id: string }>(sql`
    WITH affected AS (
      SELECT p.id, p.head_sha FROM pull_requests p
      WHERE p.repo_id = ${repoId} AND p.state = 'OPEN'
        AND (p.head_sha = ${run.headSha} OR p.number = ANY(${intArray(run.prNumbers)}))
    ),
    latest AS (
      SELECT DISTINCT ON (a.id, c.workflow_name) a.id AS pr_id, c.conclusion
      FROM affected a JOIN ci_runs c ON c.repo_id = ${repoId} AND c.head_sha = a.head_sha
      ORDER BY a.id, c.workflow_name, c.started_at DESC, c.attempt DESC
    ),
    agg AS (
      SELECT pr_id,
        CASE
          WHEN bool_or(conclusion IN ('failure', 'timed_out', 'startup_failure')) THEN 'FAILURE'
          WHEN bool_or(conclusion IS NULL) THEN 'PENDING'
          WHEN bool_or(conclusion = 'success') THEN 'SUCCESS'
          ELSE 'NONE' END AS state
      FROM latest GROUP BY pr_id
    )
    UPDATE pull_requests p SET ci_state = agg.state::ci_state, ci_updated_at = now()
    FROM agg WHERE p.id = agg.pr_id
    RETURNING p.id`);
  return r.rows.map((x) => x.id);
}

export async function upsertAgentState(
  tx: Tx,
  employeeId: string,
  s: {
    activity: string;
    provenance: string;
    sourceVerb: string;
    sourceLabel: string;
    sourceUrl: string | null;
    occurredAt: Date;
    expiresAt: Date;
  },
): Promise<boolean> {
  const r = await tx.execute(sql`
    INSERT INTO agent_states (employee_id, activity, provenance, source_verb, source_label, source_url, occurred_at, expires_at, updated_at)
    VALUES (${employeeId}, ${s.activity}, ${s.provenance}::provenance, ${s.sourceVerb}, ${s.sourceLabel}, ${s.sourceUrl},
            ${s.occurredAt}, ${s.expiresAt}, now())
    ON CONFLICT (employee_id) DO UPDATE SET
      activity = EXCLUDED.activity, provenance = EXCLUDED.provenance, source_verb = EXCLUDED.source_verb,
      source_label = EXCLUDED.source_label, source_url = EXCLUDED.source_url,
      occurred_at = EXCLUDED.occurred_at, expires_at = EXCLUDED.expires_at, updated_at = now()
    WHERE EXCLUDED.occurred_at >= agent_states.occurred_at
    RETURNING employee_id`);
  return r.rows.length > 0;
}
