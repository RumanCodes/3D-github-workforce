/**
 * Every number here is computed from the PR / review / CI projections, which are themselves
 * derived from stored events, so any figure can be traced back to the events behind it.
 * Metrics are flow and outcome measures; there are deliberately no commit or line counts.
 */
import { Injectable } from '@nestjs/common';
import type {
  FlowWeek,
  Overview,
  PullRequestDTO,
  ReviewerLoad,
  ReviewPair,
  SizeBucket,
  WorkflowHealth,
} from '@workforce/contracts';
import { sql } from 'drizzle-orm';
import type { AuthUser } from '../auth/session.service';
import { textArray } from '../db/db';
import { agentDtos, feedEvents, pullRequestDtos } from '../dto';
import { type Db, InjectDb } from '../infra/infra.module';

const H = (a: string, b: string) => `GREATEST(0, EXTRACT(EPOCH FROM (${b}) - (${a})) / 3600.0)`;
const P50 = (expr: string) => sql.raw(`ROUND((percentile_cont(0.5) WITHIN GROUP (ORDER BY ${expr}))::numeric, 1)::float`);
const READY = 'COALESCE(p.ready_at, p.created_at)';
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
export const HIDDEN_FROM_FEED = ['ci.started', 'pr.updated', 'review.commented'];

@Injectable()
export class MetricsService {
  constructor(@InjectDb() private readonly db: Db) {}

  async overview(now = new Date()): Promise<Overview> {
    const r = (
      await this.db.execute<any>(sql`
      SELECT
        (SELECT count(*) FROM pull_requests WHERE state = 'OPEN' AND NOT draft)::int AS open_prs,
        (SELECT count(*) FROM pull_requests WHERE state = 'OPEN' AND NOT draft AND first_review_at IS NULL)::int AS awaiting,
        (SELECT count(*) FROM pull_requests WHERE state = 'OPEN' AND ci_state = 'FAILURE')::int AS failing,
        (SELECT count(*) FROM pull_requests WHERE merged_at > ${now}::timestamptz - interval '7 days')::int AS merged_week,
        (SELECT count(*) FROM pull_requests WHERE merged_at > ${now}::timestamptz - interval '14 days'
                                              AND merged_at <= ${now}::timestamptz - interval '7 days')::int AS merged_prev,
        (SELECT ${P50(H(READY, 'p.first_review_at'))} FROM pull_requests p
          WHERE p.first_review_at > ${now}::timestamptz - interval '30 days') AS pickup,
        (SELECT ${P50(H('p.created_at', 'p.merged_at'))} FROM pull_requests p
          WHERE p.merged_at > ${now}::timestamptz - interval '30 days') AS cycle,
        (SELECT round(avg(CASE WHEN conclusion = 'success' THEN 1.0 ELSE 0 END)::numeric, 3)::float FROM (
            SELECT DISTINCT ON (github_id) conclusion FROM ci_runs
            WHERE completed_at > ${now}::timestamptz - interval '7 days' AND conclusion IN ('success', 'failure', 'timed_out')
            ORDER BY github_id, attempt DESC) x) AS pass_rate,
        (SELECT max(recorded_at) FROM events) AS last_event`)
    ).rows[0];
    return {
      openPrs: r.open_prs,
      awaitingReview: r.awaiting,
      failingCi: r.failing,
      mergedThisWeek: r.merged_week,
      mergedLastWeek: r.merged_prev,
      pickupHoursP50: num(r.pickup),
      cycleHoursP50: num(r.cycle),
      ciPassRate: num(r.pass_rate),
      lastEventAt: r.last_event ? new Date(r.last_event).toISOString() : null,
    };
  }

  async attention(user: AuthUser, now = new Date()) {
    const mine = textArray(user.githubIds);
    const [waiting, requestedFromMe, failing, stale, myOpen] = await Promise.all([
      pullRequestDtos(this.db, sql`p.state = 'OPEN' AND NOT p.draft AND p.first_review_at IS NULL`, now),
      pullRequestDtos(this.db, sql`p.state = 'OPEN' AND p.requested_reviewers && ${mine}`, now),
      pullRequestDtos(this.db, sql`p.state = 'OPEN' AND p.ci_state = 'FAILURE'`, now),
      pullRequestDtos(this.db, sql`p.state = 'OPEN' AND p.last_activity_at < ${now}::timestamptz - interval '3 days'`, now),
      pullRequestDtos(this.db, sql`p.state = 'OPEN' AND p.author_ext_id = ANY(${mine})`, now),
    ]);
    const byWait = (a: PullRequestDTO, b: PullRequestDTO) => (b.waitingHours ?? 0) - (a.waitingHours ?? 0);
    const byIdle = (a: PullRequestDTO, b: PullRequestDTO) => a.lastActivityAt.localeCompare(b.lastActivityAt);
    return {
      waitingForReview: waiting.sort(byWait).slice(0, 25),
      requestedFromMe: requestedFromMe.sort(byIdle),
      failingCi: failing.sort(byIdle).slice(0, 25),
      stale: stale.sort(byIdle).slice(0, 25),
      myOpen: myOpen.sort(byIdle),
    };
  }

  feed(limit = 60, beforeIso?: string) {
    const before = beforeIso ? sql` AND ev.occurred_at < ${new Date(beforeIso)}` : sql``;
    return feedEvents(this.db, sql`ev.verb <> ALL(${textArray(HIDDEN_FROM_FEED)})${before}`, limit);
  }

  team(now = new Date()) {
    return agentDtos(this.db, sql`TRUE`, now);
  }

  async flow(days: number, now = new Date()): Promise<{ weeks: FlowWeek[]; sizes: SizeBucket[] }> {
    const weeks = (
      await this.db.execute<any>(sql`
      SELECT date_trunc('week', p.merged_at) AS week, count(*)::int AS merged,
        ${P50(H('p.created_at', READY))} AS draft,
        ${P50(H(READY, 'p.first_review_at'))} AS pickup,
        ${P50(H('p.first_review_at', 'p.approved_at'))} AS review,
        ${P50(H(`COALESCE(p.approved_at, p.first_review_at, ${READY})`, 'p.merged_at'))} AS merge
      FROM pull_requests p
      WHERE p.merged_at > ${now}::timestamptz - make_interval(days => ${days})
      GROUP BY 1 ORDER BY 1`)
    ).rows.map(
      (r: any): FlowWeek => ({
        weekStart: new Date(r.week).toISOString(),
        merged: r.merged,
        draftHoursP50: num(r.draft),
        pickupHoursP50: num(r.pickup),
        reviewHoursP50: num(r.review),
        mergeHoursP50: num(r.merge),
      }),
    );
    const sizes = (
      await this.db.execute<any>(sql`
      WITH s AS (
        SELECT p.*, p.additions + p.deletions AS lines,
          CASE WHEN p.additions + p.deletions < 10 THEN 'XS (<10)'
               WHEN p.additions + p.deletions < 50 THEN 'S (10–49)'
               WHEN p.additions + p.deletions < 250 THEN 'M (50–249)'
               WHEN p.additions + p.deletions < 1000 THEN 'L (250–999)'
               ELSE 'XL (1000+)' END AS bucket
        FROM pull_requests p WHERE p.merged_at > ${now}::timestamptz - make_interval(days => ${days}))
      SELECT bucket, count(*)::int AS count, ${P50(H(READY, 'p.first_review_at'))} AS pickup, min(lines) AS ord
      FROM s p GROUP BY bucket ORDER BY ord`)
    ).rows.map((r: any): SizeBucket => ({ bucket: r.bucket, count: r.count, pickupHoursP50: num(r.pickup) }));
    return { weeks, sizes };
  }

  /**
   * Review load and response time. Members see their own row, leads their team's rows, admins everyone.
   * Author→reviewer pairs name individuals, so only admins see them.
   */
  async reviews(user: AuthUser, days: number, now = new Date()): Promise<{ load: ReviewerLoad[]; pairs: ReviewPair[]; restricted: boolean }> {
    const restricted = user.role !== 'ADMIN';
    const onlyMe =
      user.role === 'ADMIN'
        ? sql``
        : user.role === 'LEAD' && user.teamId
          ? sql`AND (rv.ext = ANY(${textArray(user.githubIds)}) OR e.team_id = ${user.teamId})`
          : sql`AND rv.ext = ANY(${textArray(user.githubIds)})`;
    const load = (
      await this.db.execute<any>(sql`
      WITH rv AS (
        SELECT r.reviewer_ext_id AS ext,
               count(*) FILTER (WHERE r.reviewer_ext_id <> p.author_ext_id)::int AS reviews,
               count(*) FILTER (WHERE r.state = 'APPROVED' AND r.reviewer_ext_id <> p.author_ext_id)::int AS approvals,
               count(*) FILTER (WHERE r.state = 'CHANGES_REQUESTED')::int AS changes
        FROM reviews r JOIN pull_requests p ON p.id = r.pr_id
        WHERE r.submitted_at > ${now}::timestamptz - make_interval(days => ${days})
        GROUP BY 1),
      pending AS (
        SELECT unnest(requested_reviewers) AS ext, count(*)::int AS n FROM pull_requests WHERE state = 'OPEN' GROUP BY 1),
      response AS (
        -- request → that reviewer's first review on the same PR
        SELECT ev.data->>'reviewerExtId' AS ext,
               ${P50(H('ev.occurred_at', 'fr.first_at'))} AS p50
        FROM events ev
        JOIN repositories repo ON repo.id = ev.repo_id
        JOIN pull_requests p ON p.repo_id = repo.id AND (repo.github_id::text || ':' || p.number) = ev.subject_id
        JOIN LATERAL (SELECT min(r.submitted_at) AS first_at FROM reviews r
                      WHERE r.pr_id = p.id AND r.reviewer_ext_id = ev.data->>'reviewerExtId'
                        AND r.submitted_at >= ev.occurred_at) fr ON fr.first_at IS NOT NULL
        WHERE ev.verb = 'pr.review_requested' AND ev.occurred_at > ${now}::timestamptz - make_interval(days => ${days})
        GROUP BY 1)
      SELECT rv.ext, COALESCE(e.id, rv.ext) AS employee_id, COALESCE(e.display_name, i.handle, rv.ext) AS name,
             rv.reviews, rv.approvals, rv.changes, COALESCE(pending.n, 0) AS pending, response.p50
      FROM rv
      LEFT JOIN external_identities i ON i.source = 'GITHUB' AND i.external_id = rv.ext
      LEFT JOIN employees e ON e.id = i.employee_id
      LEFT JOIN pending ON pending.ext = rv.ext
      LEFT JOIN response ON response.ext = rv.ext
      WHERE rv.reviews > 0 AND (i.handle IS NULL OR i.handle NOT LIKE '%[bot]') ${onlyMe}
      ORDER BY rv.reviews DESC`)
    ).rows.map(
      (r: any): ReviewerLoad => ({
        employeeId: r.employee_id,
        name: r.name,
        reviews: r.reviews,
        approvals: r.approvals,
        changesRequested: r.changes,
        pendingRequests: r.pending,
        responseHoursP50: num(r.p50),
      }),
    );
    if (restricted) return { load, pairs: [], restricted };
    const pairs = (
      await this.db.execute<any>(sql`
      SELECT COALESCE(ae.display_name, ai.handle) AS author, COALESCE(re.display_name, ri.handle) AS reviewer, count(*)::int AS count
      FROM reviews r JOIN pull_requests p ON p.id = r.pr_id
      LEFT JOIN external_identities ai ON ai.source = 'GITHUB' AND ai.external_id = p.author_ext_id
      LEFT JOIN employees ae ON ae.id = ai.employee_id
      LEFT JOIN external_identities ri ON ri.source = 'GITHUB' AND ri.external_id = r.reviewer_ext_id
      LEFT JOIN employees re ON re.id = ri.employee_id
      WHERE r.submitted_at > ${now}::timestamptz - make_interval(days => ${days}) AND r.reviewer_ext_id <> p.author_ext_id
      GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 60`)
    ).rows as ReviewPair[];
    return { load, pairs, restricted };
  }

  async ci(days: number, now = new Date()): Promise<WorkflowHealth[]> {
    return (
      await this.db.execute<any>(sql`
      WITH runs AS (
        SELECT c.*, r.full_name FROM ci_runs c JOIN repositories r ON r.id = c.repo_id
        WHERE c.started_at > ${now}::timestamptz - make_interval(days => ${days}) AND c.conclusion IS NOT NULL
          AND c.conclusion NOT IN ('skipped', 'cancelled')),
      final AS (SELECT DISTINCT ON (github_id) * FROM runs ORDER BY github_id, attempt DESC),
      flaky AS (
        -- a run whose earlier attempt failed and a later attempt on the same commit passed
        SELECT DISTINCT a.github_id, a.full_name, a.workflow_name FROM runs a JOIN runs b
          ON a.github_id = b.github_id AND b.attempt > a.attempt
        WHERE a.conclusion IN ('failure', 'timed_out') AND b.conclusion = 'success'),
      last AS (SELECT DISTINCT ON (full_name, workflow_name) full_name, workflow_name, conclusion, completed_at, url
               FROM runs ORDER BY full_name, workflow_name, started_at DESC, attempt DESC)
      SELECT f.full_name AS repo, f.workflow_name AS workflow, count(*)::int AS runs,
             round(avg(CASE WHEN f.conclusion = 'success' THEN 1.0 ELSE 0 END)::numeric, 3)::float AS pass_rate,
             ${P50(`EXTRACT(EPOCH FROM f.completed_at - f.started_at) / 60.0`)} AS dur,
             (SELECT count(*) FROM flaky x WHERE x.full_name = f.full_name AND x.workflow_name = f.workflow_name)::int AS flaky,
             l.conclusion AS last_conclusion, l.completed_at AS last_at, l.url AS last_url
      FROM final f JOIN last l ON l.full_name = f.full_name AND l.workflow_name = f.workflow_name
      GROUP BY f.full_name, f.workflow_name, l.conclusion, l.completed_at, l.url
      ORDER BY pass_rate ASC, runs DESC`)
    ).rows.map(
      (r: any): WorkflowHealth => ({
        repo: r.repo,
        workflow: r.workflow,
        runs: r.runs,
        passRate: Number(r.pass_rate),
        durationMinP50: num(r.dur),
        flakyRuns: r.flaky,
        lastConclusion: r.last_conclusion,
        lastRunAt: r.last_at ? new Date(r.last_at).toISOString() : null,
        lastRunUrl: r.last_url,
      }),
    );
  }

  async person(employeeId: string, days: number, now = new Date()) {
    const emp = (
      await this.db.execute<any>(sql`
      SELECT e.id, e.display_name AS name, e.avatar_url AS "avatarUrl", e.role, t.name AS team,
             COALESCE(array_agg(i.external_id) FILTER (WHERE i.external_id IS NOT NULL), '{}') AS ids,
             COALESCE(array_agg(i.handle) FILTER (WHERE i.handle IS NOT NULL), '{}') AS handles
      FROM employees e LEFT JOIN teams t ON t.id = e.team_id
      LEFT JOIN external_identities i ON i.employee_id = e.id AND i.source = 'GITHUB'
      WHERE e.id = ${employeeId} GROUP BY e.id, t.name`)
    ).rows[0];
    if (!emp) return null;
    const ids = textArray(emp.ids);
    const stats = (
      await this.db.execute<any>(sql`
      SELECT
        (SELECT count(*) FROM pull_requests WHERE author_ext_id = ANY(${ids}) AND merged_at > ${now}::timestamptz - make_interval(days => ${days}))::int AS merged,
        (SELECT count(*) FROM reviews r JOIN pull_requests p ON p.id = r.pr_id
          WHERE r.reviewer_ext_id = ANY(${ids}) AND r.reviewer_ext_id <> p.author_ext_id
            AND r.submitted_at > ${now}::timestamptz - make_interval(days => ${days}))::int AS reviews_given,
        (SELECT ${P50(H(READY, 'p.first_review_at'))} FROM pull_requests p
          WHERE p.author_ext_id = ANY(${ids}) AND p.first_review_at > ${now}::timestamptz - make_interval(days => ${days})) AS pickup_on_mine,
        (SELECT ${P50(H('p.created_at', 'p.merged_at'))} FROM pull_requests p
          WHERE p.author_ext_id = ANY(${ids}) AND p.merged_at > ${now}::timestamptz - make_interval(days => ${days})) AS cycle,
        (SELECT count(DISTINCT r.pr_id) FROM reviews r JOIN pull_requests p ON p.id = r.pr_id
          JOIN repositories repo ON repo.id = p.repo_id
          WHERE r.reviewer_ext_id = ANY(${ids}) AND p.author_ext_id <> ALL(${ids})
            AND r.submitted_at > ${now}::timestamptz - make_interval(days => ${days}))::int AS prs_reviewed`)
    ).rows[0];
    const [openPrs, waitingOnThem, recent] = await Promise.all([
      pullRequestDtos(this.db, sql`p.state = 'OPEN' AND p.author_ext_id = ANY(${ids})`, now),
      pullRequestDtos(this.db, sql`p.state = 'OPEN' AND p.requested_reviewers && ${ids}`, now),
      feedEvents(this.db, sql`ev.actor_ext_id = ANY(${ids}) AND ev.verb <> ALL(${textArray(HIDDEN_FROM_FEED)})`, 40),
    ]);
    return {
      employee: { id: emp.id, name: emp.name, avatarUrl: emp.avatarUrl, role: emp.role, team: emp.team, githubLogins: emp.handles },
      days,
      stats: {
        prsMerged: stats.merged,
        reviewsGiven: stats.reviews_given,
        prsReviewed: stats.prs_reviewed,
        pickupHoursOnTheirPrsP50: num(stats.pickup_on_mine),
        cycleHoursP50: num(stats.cycle),
      },
      openPrs,
      waitingOnThem,
      recent,
    };
  }
}
