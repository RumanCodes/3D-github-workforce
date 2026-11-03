/** Builders that turn rows into the shared contract shapes the web app consumes. */
import type { AgentStateDTO, FeedEvent, PullRequestDTO } from '@workforce/contracts';
import { sql } from 'drizzle-orm';
import type { DbOrTx } from './db/db';
import { ACTIVITY_LABEL } from './presence/derive-activity';

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);
const hoursBetween = (a: Date, b: Date) => Math.round(((b.getTime() - a.getTime()) / 3_600_000) * 10) / 10;

/** Display identity: the employee's name when linked, otherwise the GitHub login. */
const PERSON = (alias: string, idCol: string, extCol: string) => sql.raw(`
  LEFT JOIN external_identities ${alias}_i ON ${alias}_i.source = 'GITHUB' AND ${alias}_i.external_id = ${extCol}
  LEFT JOIN employees ${alias}_e ON ${alias}_e.id = COALESCE(${idCol}, ${alias}_i.employee_id)`);

export async function feedEvents(db: DbOrTx, where: ReturnType<typeof sql>, limit = 50): Promise<FeedEvent[]> {
  const r = await db.execute<any>(sql`
    SELECT ev.id, ev.verb, ev.data, ev.occurred_at, ev.provenance, ev.url, ev.summary, ev.actor_ext_id,
           COALESCE(ev.actor_id, a_i.employee_id) AS actor_id,
           COALESCE(a_e.display_name, a_i.handle) AS actor_name,
           COALESCE(a_e.avatar_url, a_i.avatar_url) AS actor_avatar,
           r.full_name AS repo
    FROM events ev
    ${PERSON('a', 'ev.actor_id', 'ev.actor_ext_id')}
    LEFT JOIN repositories r ON r.id = ev.repo_id
    WHERE ${where}
    ORDER BY ev.occurred_at DESC
    LIMIT ${limit}`);
  return r.rows.map(
    (x: any): FeedEvent => ({
      id: x.id,
      live: x.provenance === 'VERIFIED' || x.data?.livePoll === true,
      verb: x.verb,
      occurredAt: iso(x.occurred_at)!,
      provenance: x.provenance,
      actor: x.actor_name ? { id: x.actor_id, name: x.actor_name, avatarUrl: x.actor_avatar } : null,
      repo: x.repo,
      subject: x.verb.split('.')[0],
      url: x.url,
      summary: x.summary,
    }),
  );
}

export async function pullRequestDtos(db: DbOrTx, where: ReturnType<typeof sql>, now = new Date()): Promise<PullRequestDTO[]> {
  const r = await db.execute<any>(sql`
    SELECT p.*, r.full_name AS repo,
           COALESCE(p.author_id, au_i.employee_id) AS author_emp,
           COALESCE(au_e.display_name, au_i.handle, p.author_ext_id) AS author_name,
           COALESCE(au_e.avatar_url, au_i.avatar_url) AS author_avatar,
           (SELECT COALESCE(array_agg(COALESCE(e.display_name, i.handle)), '{}')
              FROM unnest(p.requested_reviewers) rr(ext)
              LEFT JOIN external_identities i ON i.source = 'GITHUB' AND i.external_id = rr.ext
              LEFT JOIN employees e ON e.id = i.employee_id) AS reviewer_names
    FROM pull_requests p
    JOIN repositories r ON r.id = p.repo_id
    ${PERSON('au', 'p.author_id', 'p.author_ext_id')}
    WHERE ${where}`);
  return r.rows.map((x: any): PullRequestDTO => {
    const ready = x.ready_at ?? x.created_at;
    const waiting = x.state === 'OPEN' && !x.draft && !x.first_review_at ? hoursBetween(new Date(ready), now) : null;
    return {
      id: x.id,
      repo: x.repo,
      number: x.number,
      title: x.title,
      url: x.url,
      author: { id: x.author_emp, name: x.author_name, avatarUrl: x.author_avatar },
      state: x.state,
      draft: x.draft,
      ciState: x.ci_state,
      size: (x.additions ?? 0) + (x.deletions ?? 0),
      createdAt: iso(x.created_at)!,
      readyAt: iso(x.ready_at),
      firstReviewAt: iso(x.first_review_at),
      approvedAt: iso(x.approved_at),
      mergedAt: iso(x.merged_at),
      lastActivityAt: iso(x.last_activity_at)!,
      requestedReviewers: (x.reviewer_names ?? []).filter(Boolean),
      waitingHours: waiting,
    };
  });
}

export async function agentDtos(db: DbOrTx, where: ReturnType<typeof sql>, now = new Date()): Promise<AgentStateDTO[]> {
  const r = await db.execute<any>(sql`
    SELECT e.id, e.display_name,
           COALESCE(e.avatar_url, (SELECT i.avatar_url FROM external_identities i WHERE i.employee_id = e.id AND i.avatar_url IS NOT NULL LIMIT 1)) AS avatar_url,
           t.name AS team,
           s.activity, s.provenance, s.source_verb, s.source_label, s.source_url, s.occurred_at, s.expires_at
    FROM employees e
    LEFT JOIN teams t ON t.id = e.team_id
    LEFT JOIN agent_states s ON s.employee_id = e.id AND s.expires_at > ${now}
    WHERE e.active AND ${where}
    ORDER BY t.name NULLS LAST, e.display_name`);
  return r.rows.map(
    (x: any): AgentStateDTO => ({
      employeeId: x.id,
      name: x.display_name,
      avatarUrl: x.avatar_url,
      team: x.team,
      activity: x.activity && x.activity !== 'NONE' ? x.activity : 'NONE',
      provenance: x.provenance ?? 'INFERRED',
      source: x.activity
        ? { verb: x.source_verb, occurredAt: iso(x.occurred_at)!, url: x.source_url, label: x.source_label }
        : null,
      expiresAt: iso(x.expires_at),
    }),
  );
}

export { ACTIVITY_LABEL };
