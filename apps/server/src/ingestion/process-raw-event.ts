/**
 * Normalizes one stored raw event and applies everything it implies in ONE transaction per canonical event:
 *   event log row (idempotent) → projections → agent state → outbox rows for the live UI.
 * If anything throws, nothing is half-written, and the job is retried.
 */
import { sql } from 'drizzle-orm';
import { ZodError } from 'zod';
import { textArray, type Db, type Tx } from '../db/db';
import { agentDtos, feedEvents, pullRequestDtos } from '../dto';
import { deriveActivity } from '../presence/derive-activity';
import { type CanonicalEvent, normalizeGithub } from './github-normalizer';
import {
  dismissReview,
  insertReview,
  recomputeReviewTimes,
  upsertAgentState,
  upsertCiRun,
  upsertIdentity,
  upsertPullRequest,
  upsertRepo,
} from './projections';

export type ProcessResult = { status: 'NORMALIZED' | 'IGNORED' | 'FAILED' | 'ALREADY_DONE'; inserted: number };

/** Marker for errors that retrying cannot fix (malformed payloads). */
export class PermanentError extends Error {}

export async function processRawEvent(db: Db, rawId: string, now = new Date()): Promise<ProcessResult> {
  const raw = (
    await db.execute<any>(sql`SELECT id, source, event_type, payload, status FROM raw_events WHERE id = ${rawId}`)
  ).rows[0];
  if (!raw) throw new PermanentError(`raw event ${rawId} not found`);
  if (raw.status === 'NORMALIZED' || raw.status === 'IGNORED') return { status: 'ALREADY_DONE', inserted: 0 };

  if (raw.source === 'GITHUB' && ['installation', 'installation_repositories'].includes(raw.event_type)) {
    const p = raw.payload;
    const org = process.env.GITHUB_ORG;
    if (org && p.installation?.account?.login?.toLowerCase() === org.toLowerCase()) {
      await db.transaction(async tx => {
        const enabled = !['deleted', 'suspend'].includes(p.action);
        await tx.execute(sql`INSERT INTO github_installations(id,login,enabled) VALUES(${p.installation.id},${p.installation.account.login},${enabled}) ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled`);
        if (!enabled) await tx.execute(sql`UPDATE repositories SET connected=false WHERE lower(split_part(full_name,'/',1))=lower(${org})`);
        for (const repo of p.repositories_removed ?? []) await tx.execute(sql`UPDATE repositories SET connected=false WHERE github_id=${repo.id}`);
        await tx.execute(sql`UPDATE raw_events SET status='NORMALIZED' WHERE id=${rawId}`);
      });
      return { status: 'NORMALIZED', inserted: 0 };
    }
  }
  if (process.env.GITHUB_APP_ID && raw.payload?.repository) {
    const connected = (await db.execute<any>(sql`SELECT r.id FROM repositories r JOIN github_installations i ON lower(i.login)=lower(split_part(r.full_name,'/',1)) WHERE r.github_id=${raw.payload.repository.id} AND r.connected AND i.enabled`)).rows[0];
    if (!connected) {
      await db.execute(sql`UPDATE raw_events SET status='IGNORED' WHERE id=${rawId}`);
      return { status: 'IGNORED', inserted: 0 };
    }
  }
  let canon: CanonicalEvent[];
  try {
    canon = normalizeGithub({ eventType: raw.event_type, payload: raw.payload, source: raw.source });
  } catch (err) {
    const msg = err instanceof ZodError ? `payload validation: ${err.issues[0]?.path.join('.')} ${err.issues[0]?.message}` : String(err);
    await db.execute(sql`UPDATE raw_events SET status = 'FAILED', error = ${msg}, attempts = attempts + 1 WHERE id = ${rawId}`);
    return { status: 'FAILED', inserted: 0 };
  }

  if (canon.length === 0) {
    await db.execute(sql`UPDATE raw_events SET status = 'IGNORED' WHERE id = ${rawId}`);
    return { status: 'IGNORED', inserted: 0 };
  }

  if (raw.source === 'GITHUB_POLL') for (const ev of canon) ev.data = { ...ev.data, livePoll: true };
  let inserted = 0;
  for (const ev of canon) {
    const didInsert = await db.transaction((tx) => applyCanonicalEvent(tx, ev, rawId, now));
    if (didInsert) inserted++;
  }
  await db.execute(sql`UPDATE raw_events SET status = 'NORMALIZED', error = NULL, attempts = attempts + 1 WHERE id = ${rawId}`);
  return { status: 'NORMALIZED', inserted };
}

function lockKey(ev: CanonicalEvent): string | null {
  const p = ev.projection;
  if (!ev.repo) return null;
  if (p.kind === 'pr' || p.kind === 'review' || p.kind === 'review_dismissed') return `pr:${ev.repo.githubId}:${p.pr.number}`;
  if (p.kind === 'ci') return `ci:${ev.repo.githubId}:${p.run.headSha}`;
  return null;
}

/** Returns true if this was a new event (false = duplicate, nothing changed). */
export async function applyCanonicalEvent(tx: Tx, ev: CanonicalEvent, rawId: string | null, now: Date): Promise<boolean> {
  const key = lockKey(ev);
  if (key) await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${key}))`);

  const repoId = ev.repo ? await upsertRepo(tx, ev.repo) : null;
  const actorId = ev.actor ? await upsertIdentity(tx, ev.actor) : null;

  const ins = await tx.execute<{ id: string }>(sql`
    INSERT INTO events (id, raw_event_id, dedupe_key, occurred_at, actor_id, actor_ext_id, verb, repo_id,
                        subject_type, subject_id, provenance, url, summary, data)
    VALUES (gen_random_uuid()::text, ${rawId}, ${ev.dedupeKey}, ${ev.occurredAt}, ${actorId}, ${ev.actor?.extId ?? null},
            ${ev.verb}, ${repoId}, ${ev.subjectType}, ${ev.subjectId}, ${ev.provenance}::provenance, ${ev.url},
            ${ev.summary}, ${JSON.stringify(ev.data)}::jsonb)
    ON CONFLICT (dedupe_key) DO NOTHING
    RETURNING id`);
  const eventId = ins.rows[0]?.id;
  if (!eventId) return false; // duplicate delivery or webhook/backfill overlap

  // ---- projections ----
  const touchedPrs = new Set<string>();
  const p = ev.projection;
  if (repoId && p.kind === 'pr') {
    const authorId = await upsertIdentity(tx, p.pr.author);
    touchedPrs.add(await upsertPullRequest(tx, repoId, p.pr, authorId, ev.occurredAt, p.readyAt));
  } else if (repoId && p.kind === 'review') {
    const authorId = await upsertIdentity(tx, p.pr.author);
    const prId = await upsertPullRequest(tx, repoId, p.pr, authorId, ev.occurredAt, undefined);
    await insertReview(tx, prId, p.review, actorId);
    await recomputeReviewTimes(tx, prId);
    touchedPrs.add(prId);
  } else if (repoId && p.kind === 'review_dismissed') {
    const prId = await dismissReview(tx, p.reviewGithubId);
    if (prId) {
      await recomputeReviewTimes(tx, prId);
      touchedPrs.add(prId);
    }
  } else if (repoId && p.kind === 'ci') {
    for (const id of await upsertCiRun(tx, repoId, p.run)) touchedPrs.add(id);
  }

  // ---- outbox: what the live UI needs, written in the same transaction ----
  const out: { topic: string; payload: unknown }[] = [];
  if (ev.feed) {
    const [fe] = await feedEvents(tx, sql`ev.id = ${eventId}`, 1);
    if (fe) out.push({ topic: 'org', payload: { type: 'event', event: fe } });
  }
  if (touchedPrs.size) {
    const ids = [...touchedPrs];
    for (const pr of await pullRequestDtos(tx, sql`p.id = ANY(${textArray(ids)})`, now)) {
      out.push({ topic: 'org', payload: { type: 'pr', pr } });
    }
  }
  if (actorId && ev.actor && !ev.actor.isBot) {
    const derived = deriveActivity(
      { verb: ev.verb, provenance: ev.provenance, occurredAt: ev.occurredAt, data: ev.data as any },
      now,
      ev.data.livePoll === true,
    );
    if (derived) {
      const changed = await upsertAgentState(tx, actorId, {
        activity: derived.activity,
        provenance: derived.provenance,
        sourceVerb: ev.verb,
        sourceLabel: ev.summary,
        sourceUrl: ev.url,
        occurredAt: ev.occurredAt,
        expiresAt: derived.expiresAt,
      });
      if (changed) {
        const [agent] = await agentDtos(tx, sql`e.id = ${actorId}`, now);
        if (agent) out.push({ topic: 'org', payload: { type: 'agent', agent } });
      }
    }
  }
  if (out.length) await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('workforce-outbox-order'))`);
  for (const o of out) {
    await tx.execute(sql`INSERT INTO outbox (topic, payload) VALUES (${o.topic}, ${JSON.stringify(o.payload)}::jsonb)`);
  }
  return true;
}
