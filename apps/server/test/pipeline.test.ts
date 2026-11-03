import { sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { signGithubPayload, verifyGithubSignature } from '../src/github/verify';
import { insertRawIfNew } from '../src/ingestion/raw-store';
import {
  type PrState,
  prEvent,
  reviewEvent,
  workflowRunEvent,
} from '../scripts/lib/github-payloads';
import { ingest, one, resetDb, testDb } from './helpers';

const { db, pool } = testDb();
afterAll(() => pool.end());
beforeEach(() => resetDb(db));

const repo = { id: 501, full_name: 'acme/api' };
const alice = { id: 1001, login: 'alice' };
const bob = { id: 1002, login: 'bob' };
const t = (iso: string) => new Date(iso);

const basePr = (over: Partial<PrState> = {}): PrState => ({
  repo,
  number: 7,
  title: 'Fix login redirect',
  author: alice,
  createdAt: t('2026-10-01T09:00:00Z'),
  updatedAt: t('2026-10-01T09:00:00Z'),
  headSha: 'aaa111',
  ...over,
});

describe('webhook signatures', () => {
  it('accepts the exact body and rejects any change', () => {
    const body = Buffer.from('{"a":1}');
    const sig = signGithubPayload(body, 'secret-123');
    expect(verifyGithubSignature(body, sig, 'secret-123')).toBe(true);
    expect(verifyGithubSignature(Buffer.from('{"a":2}'), sig, 'secret-123')).toBe(false);
    expect(verifyGithubSignature(body, sig, 'other-secret')).toBe(false);
    expect(verifyGithubSignature(body, undefined, 'secret-123')).toBe(false);
  });
});

describe('idempotency', () => {
  it('stores a redelivered webhook once', async () => {
    const e = prEvent('opened', basePr(), alice);
    const a = await insertRawIfNew(db, { source: 'GITHUB', externalEventId: 'd-1', ...e });
    const b = await insertRawIfNew(db, { source: 'GITHUB', externalEventId: 'd-1', ...e });
    expect(a).toBeTruthy();
    expect(b).toBeNull();
  });

  it('collapses a webhook and a backfill of the same fact into one event', async () => {
    const e = prEvent('opened', basePr(), alice);
    await ingest(db, e, { source: 'GITHUB' });
    const r = await ingest(db, e, { source: 'GITHUB_BACKFILL' });
    expect(r?.inserted).toBe(0);
    const { n } = await one(db, sql`SELECT count(*)::int AS n FROM events WHERE verb = 'pr.opened'`);
    expect(n).toBe(1);
  });

  it('marks a malformed payload FAILED instead of throwing', async () => {
    const r = await ingest(db, { eventType: 'pull_request', payload: { action: 'opened', repository: { id: 1, full_name: 'x/y' }, pull_request: { number: 'oops' } } });
    expect(r?.status).toBe('FAILED');
    const raw = await one(db, sql`SELECT status, error FROM raw_events`);
    expect(raw.status).toBe('FAILED');
    expect(raw.error).toContain('payload validation');
  });

  it('ignores events it does not track', async () => {
    const r = await ingest(db, { eventType: 'ping', payload: { zen: 'Keep it logically awesome.' } });
    expect(r?.status).toBe('IGNORED');
  });
});

describe('ordering', () => {
  it('reaches the same final state when "merged" arrives before "opened"', async () => {
    const merged = basePr({
      updatedAt: t('2026-10-02T15:00:00Z'),
      mergedAt: t('2026-10-02T15:00:00Z'),
      mergedBy: bob,
    });
    await ingest(db, prEvent('closed', merged, bob));
    await ingest(db, prEvent('opened', basePr(), alice));
    const pr = await one(db, sql`SELECT state, merged_at, ready_at, created_at FROM pull_requests`);
    expect(pr.state).toBe('MERGED');
    expect(new Date(pr.merged_at).toISOString()).toBe('2026-10-02T15:00:00.000Z');
    expect(new Date(pr.ready_at).toISOString()).toBe('2026-10-01T09:00:00.000Z');
  });

  it('does not let an older snapshot overwrite a newer title', async () => {
    await ingest(db, prEvent('edited', basePr({ title: 'New title', updatedAt: t('2026-10-01T12:00:00Z') }), alice));
    await ingest(db, prEvent('opened', basePr({ title: 'Old title' }), alice));
    const pr = await one(db, sql`SELECT title FROM pull_requests`);
    expect(pr.title).toBe('New title');
  });

  it('computes first review from stored reviews regardless of arrival order, excluding the author', async () => {
    const s = basePr();
    await ingest(db, reviewEvent(s, bob, 9002, 'approved', t('2026-10-01T14:00:00Z')));
    await ingest(db, reviewEvent(s, alice, 9003, 'commented', t('2026-10-01T10:00:00Z'))); // author reply
    await ingest(db, reviewEvent(s, bob, 9001, 'commented', t('2026-10-01T11:00:00Z')));
    await ingest(db, prEvent('opened', s, alice));
    const pr = await one(db, sql`SELECT first_review_at, approved_at, additions FROM pull_requests`);
    expect(new Date(pr.first_review_at).toISOString()).toBe('2026-10-01T11:00:00.000Z');
    expect(new Date(pr.approved_at).toISOString()).toBe('2026-10-01T14:00:00.000Z');
    expect(pr.additions).toBe(40); // filled in by the full snapshot
  });
});

describe('CI state', () => {
  it('uses the latest attempt per workflow on the head commit', async () => {
    const s = basePr();
    await ingest(db, prEvent('opened', s, alice));
    const run = { id: 77, name: 'CI', headSha: 'aaa111', branch: 'feature/7', startedAt: t('2026-10-01T09:05:00Z'), completedAt: t('2026-10-01T09:10:00Z'), actor: alice, prNumbers: [7] };
    await ingest(db, workflowRunEvent(repo, { ...run, conclusion: 'failure' }));
    expect((await one(db, sql`SELECT ci_state FROM pull_requests`)).ci_state).toBe('FAILURE');
    await ingest(db, workflowRunEvent(repo, { ...run, attempt: 2, conclusion: 'success', startedAt: t('2026-10-01T09:20:00Z'), completedAt: t('2026-10-01T09:25:00Z') }));
    expect((await one(db, sql`SELECT ci_state FROM pull_requests`)).ci_state).toBe('SUCCESS');
  });
});

describe('agent state and outbox', () => {
  it('infers a short-lived activity only for linked employees and recent events', async () => {
    const team = await one(db, sql`INSERT INTO teams (id, name, department) VALUES ('t1', 'Platform', 'Development') RETURNING id`);
    await db.execute(sql`INSERT INTO employees (id, display_name, team_id) VALUES ('emp-bob', 'Bob Rahman', ${team.id})`);
    await db.execute(sql`INSERT INTO external_identities (id, employee_id, source, external_id, handle) VALUES ('x', 'emp-bob', 'GITHUB', '1002', 'bob')`);

    const now = t('2026-10-01T14:05:00Z');
    await ingest(db, reviewEvent(basePr(), bob, 9100, 'approved', t('2026-10-01T14:00:00Z')), { now });
    const st = await one(db, sql`SELECT activity, provenance FROM agent_states WHERE employee_id = 'emp-bob'`);
    expect(st).toEqual({ activity: 'REVIEWING', provenance: 'INFERRED' });

    // A 3-day-old backfilled review must not animate anyone.
    await db.execute(sql`DELETE FROM agent_states`);
    await ingest(db, reviewEvent(basePr({ number: 8 }), bob, 9101, 'approved', t('2026-09-28T10:00:00Z')), { now, source: 'GITHUB_BACKFILL' });
    expect((await one(db, sql`SELECT count(*)::int AS n FROM agent_states`)).n).toBe(0);

    const kinds = (await db.execute<any>(sql`SELECT payload->>'type' AS type FROM outbox`)).rows.map((r) => r.type);
    expect(kinds).toContain('event');
    expect(kinds).toContain('pr');
    expect(kinds).toContain('agent');
  });

  it('records backfilled events as POLLED, not VERIFIED', async () => {
    await ingest(db, prEvent('opened', basePr(), alice), { source: 'GITHUB_BACKFILL' });
    expect((await one(db, sql`SELECT provenance FROM events`)).provenance).toBe('POLLED');
  });
});
