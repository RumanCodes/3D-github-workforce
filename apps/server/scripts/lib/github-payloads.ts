/**
 * Builders for realistic GitHub webhook payloads (only the fields GitHub sends that we use, plus a few extras).
 * Used by tests and by the local simulator, so both exercise the real ingestion path.
 */
export type GhUser = { id: number; login: string };
export type GhRepo = { id: number; full_name: string; default_branch?: string };

const user = (u: GhUser) => ({
  id: u.id,
  login: u.login,
  // No avatar: simulated ids may belong to real GitHub accounts, so never show their photos.
  avatar_url: null,
  type: 'User',
});
const repository = (r: GhRepo) => ({
  id: r.id,
  full_name: r.full_name,
  name: r.full_name.split('/')[1],
  private: true,
  default_branch: r.default_branch ?? 'main',
});

export type PrState = {
  repo: GhRepo;
  number: number;
  title: string;
  author: GhUser;
  createdAt: Date;
  updatedAt: Date;
  draft?: boolean;
  headSha: string;
  headRef?: string;
  additions?: number;
  deletions?: number;
  mergedAt?: Date | null;
  mergedBy?: GhUser | null;
  closedAt?: Date | null;
  requestedReviewers?: GhUser[];
};

export function pullRequestObject(s: PrState) {
  const merged = !!s.mergedAt;
  return {
    id: s.repo.id * 10_000 + s.number,
    number: s.number,
    title: s.title,
    html_url: `https://github.com/${s.repo.full_name}/pull/${s.number}`,
    user: user(s.author),
    state: s.closedAt || merged ? 'closed' : 'open',
    draft: !!s.draft,
    merged,
    merged_at: s.mergedAt?.toISOString() ?? null,
    merged_by: s.mergedBy ? user(s.mergedBy) : null,
    closed_at: (s.closedAt ?? s.mergedAt)?.toISOString() ?? null,
    created_at: s.createdAt.toISOString(),
    updated_at: s.updatedAt.toISOString(),
    additions: s.additions ?? 40,
    deletions: s.deletions ?? 10,
    head: { sha: s.headSha, ref: s.headRef ?? `feature/${s.number}` },
    requested_reviewers: (s.requestedReviewers ?? []).map(user),
  };
}

export function prEvent(action: string, s: PrState, sender: GhUser, extra: Record<string, unknown> = {}) {
  return {
    eventType: 'pull_request',
    payload: { action, number: s.number, pull_request: pullRequestObject(s), repository: repository(s.repo), sender: user(sender), ...extra },
  };
}

export function reviewRequestedEvent(s: PrState, sender: GhUser, reviewer: GhUser) {
  return prEvent('review_requested', s, sender, { requested_reviewer: user(reviewer) });
}

export function reviewEvent(s: PrState, reviewer: GhUser, reviewId: number, state: 'approved' | 'changes_requested' | 'commented', at: Date) {
  const pr = pullRequestObject(s);
  // Review payloads carry a simplified PR (no additions/merged fields).
  const { additions, deletions, merged, merged_by, ...simple } = pr;
  return {
    eventType: 'pull_request_review',
    payload: {
      action: 'submitted',
      review: { id: reviewId, user: user(reviewer), state, submitted_at: at.toISOString(), html_url: `${pr.html_url}#pullrequestreview-${reviewId}` },
      pull_request: simple,
      repository: repository(s.repo),
      sender: user(reviewer),
    },
  };
}

export function workflowRunEvent(
  repo: GhRepo,
  run: {
    id: number;
    attempt?: number;
    name: string;
    headSha: string;
    branch: string;
    conclusion: 'success' | 'failure' | null;
    startedAt: Date;
    completedAt: Date;
    actor: GhUser;
    prNumbers?: number[];
  },
) {
  const completed = run.conclusion !== null;
  return {
    eventType: 'workflow_run',
    payload: {
      action: completed ? 'completed' : 'in_progress',
      workflow_run: {
        id: run.id,
        name: run.name,
        run_attempt: run.attempt ?? 1,
        head_sha: run.headSha,
        head_branch: run.branch,
        event: 'pull_request',
        status: completed ? 'completed' : 'in_progress',
        conclusion: run.conclusion,
        html_url: `https://github.com/${repo.full_name}/actions/runs/${run.id}`,
        run_started_at: run.startedAt.toISOString(),
        created_at: run.startedAt.toISOString(),
        updated_at: (completed ? run.completedAt : run.startedAt).toISOString(),
        triggering_actor: user(run.actor),
        actor: user(run.actor),
        pull_requests: (run.prNumbers ?? []).map((n) => ({ number: n })),
      },
      repository: repository(repo),
      sender: user(run.actor),
    },
  };
}

export function pushEvent(repo: GhRepo, sender: GhUser, branch: string, after: string, commits: number, at: Date) {
  return {
    eventType: 'push',
    payload: {
      ref: `refs/heads/${branch}`,
      after,
      deleted: false,
      compare: `https://github.com/${repo.full_name}/compare/${after.slice(0, 12)}`,
      commits: Array.from({ length: commits }, (_, i) => ({ id: `${after}${i}` })),
      head_commit: { id: after, timestamp: at.toISOString() },
      repository: repository(repo),
      sender: user(sender),
    },
  };
}

export function releaseEvent(repo: GhRepo, author: GhUser, id: number, tag: string, at: Date) {
  return {
    eventType: 'release',
    payload: {
      action: 'published',
      release: { id, tag_name: tag, html_url: `https://github.com/${repo.full_name}/releases/tag/${tag}`, published_at: at.toISOString(), created_at: at.toISOString(), author: user(author), prerelease: false },
      repository: repository(repo),
      sender: user(author),
    },
  };
}
