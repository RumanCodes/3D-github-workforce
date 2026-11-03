import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { sql } from 'drizzle-orm';
import { io } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { signGithubPayload } from '../src/github/verify';
import { prEvent } from '../scripts/lib/github-payloads';
import { one, resetDb, testDb } from './helpers';

const { db, pool } = testDb();
let app: INestApplication;
let base = '';
const SECRET = process.env.GITHUB_WEBHOOK_SECRET!;

async function login(employeeId: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/dev/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ employeeId }),
  });
  expect(res.status).toBe(204);
  return res.headers.get('set-cookie')!.split(';')[0];
}

function webhook(ev: { eventType: string; payload: unknown }, delivery: string, signWith = SECRET) {
  const body = JSON.stringify(ev.payload);
  return fetch(`${base}/webhooks/github`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-GitHub-Event': ev.eventType,
      'X-GitHub-Delivery': delivery,
      'X-Hub-Signature-256': signGithubPayload(body, signWith),
    },
    body,
  });
}

const waitFor = async (check: () => Promise<boolean>, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('condition not met in time');
};

const pr = {
  repo: { id: 77, full_name: 'acme/api' },
  number: 12,
  title: 'Add retries',
  author: { id: 3001, login: 'ana' },
  createdAt: new Date(),
  updatedAt: new Date(),
  headSha: 'abc123',
};

beforeAll(async () => {
  process.env.DEV_AUTH = 'true';
  await resetDb(db);
  await db.execute(sql`INSERT INTO teams (id, name, department) VALUES ('t-a', 'A', 'Development'), ('t-b', 'B', 'Development')`);
  await db.execute(sql`INSERT INTO employees (id, display_name, role, team_id) VALUES
    ('ana', 'Ana', 'MEMBER', 't-a'), ('ben', 'Ben', 'MEMBER', 't-a'),
    ('lead-a', 'Lea', 'LEAD', 't-a'), ('lead-b', 'Lou', 'LEAD', 't-b'), ('boss', 'Bo', 'ADMIN', NULL)`);
  await db.execute(sql`INSERT INTO external_identities (id, employee_id, source, external_id, handle) VALUES ('i1', 'ana', 'GITHUB', '3001', 'ana')`);
  app = await NestFactory.create<NestExpressApplication>(AppModule.forRole('all'), { rawBody: true, logger: false });
  await app.listen(0);
  base = (await app.getUrl()).replace('[::1]', 'localhost');
});

afterAll(async () => {
  await app?.close();
  await pool.end();
});

describe('webhook endpoint', () => {
  it('rejects a bad signature and stores nothing', async () => {
    const res = await webhook(prEvent('opened', pr, pr.author), 'bad-1', 'wrong-secret');
    expect(res.status).toBe(401);
    expect((await one(db, sql`SELECT count(*)::int AS n FROM raw_events`)).n).toBe(0);
  });

  it('accepts, processes, and pushes the change to a connected browser', async () => {
    const cookie = await login('ana');
    const socket = io(base, { path: '/rt', transports: ['websocket'], extraHeaders: { cookie } });
    const received: any[] = [];
    socket.on('deltas', (m: any[]) => received.push(...m));
    await new Promise<void>((r) => socket.on('connect', () => r()));

    const res = await webhook(prEvent('opened', pr, pr.author), 'good-1');
    expect(res.status).toBe(202);
    await waitFor(async () => received.some((m) => m.type === 'event' && m.event.verb === 'pr.opened'));
    expect(received.find((m) => m.type === 'pr').pr.title).toBe('Add retries');
    socket.disconnect();
  });

  it('treats a redelivery as a duplicate', async () => {
    const res = await webhook(prEvent('opened', pr, pr.author), 'good-1');
    expect(await res.json()).toMatchObject({ duplicate: true });
    expect((await one(db, sql`SELECT count(*)::int AS n FROM events WHERE verb = 'pr.opened'`)).n).toBe(1);
  });

  it('refuses a socket without a session', async () => {
    const socket = io(base, { path: '/rt', transports: ['websocket'] });
    const got = await new Promise<string>((r) => {
      socket.on('unauthorized', () => r('unauthorized'));
      socket.on('disconnect', () => r('disconnected'));
    });
    expect(['unauthorized', 'disconnected']).toContain(got);
    socket.disconnect();
  });
});

describe('access control', () => {
  it('requires a session', async () => {
    expect((await fetch(`${base}/api/overview`)).status).toBe(401);
  });

  it('requires the client header on state-changing requests (CSRF)', async () => {
    const cookie = await login('ana');
    const res = await fetch(`${base}/api/status`, {
      method: 'POST',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ activity: 'BLOCKED' }),
    });
    expect(res.status).toBe(403);
  });

  it('lets people see their own metrics but not a peer’s', async () => {
    const cookie = await login('ana');
    expect((await fetch(`${base}/api/people/ana`, { headers: { cookie } })).status).toBe(200);
    expect((await fetch(`${base}/api/people/ben`, { headers: { cookie } })).status).toBe(403);
  });

  it('lets a lead see their own team only, and records the view', async () => {
    const lea = await login('lead-a');
    expect((await fetch(`${base}/api/people/ana`, { headers: { cookie: lea } })).status).toBe(200);
    const lou = await login('lead-b');
    expect((await fetch(`${base}/api/people/ana`, { headers: { cookie: lou } })).status).toBe(403);
    const audit = await one(db, sql`SELECT count(*)::int AS n FROM audit_log WHERE action = 'VIEW_PERSON_METRICS' AND target = 'ana'`);
    expect(audit.n).toBe(1);
    // Ana can see that her lead looked.
    const ana = await login('ana');
    const me = await (await fetch(`${base}/api/people/ana`, { headers: { cookie: ana } })).json();
    expect(me.viewedBy.map((v: any) => v.name)).toEqual(['Lea']);
  });

  it('keeps admin routes for admins', async () => {
    const lea = await login('lead-a');
    expect((await fetch(`${base}/api/admin/health`, { headers: { cookie: lea } })).status).toBe(403);
    const bo = await login('boss');
    expect((await fetch(`${base}/api/admin/health`, { headers: { cookie: bo } })).status).toBe(200);
  });

  it('records a self-reported blocker as SELF_REPORTED', async () => {
    const cookie = await login('ben');
    const res = await fetch(`${base}/api/status`, {
      method: 'POST',
      headers: { cookie, 'Content-Type': 'application/json', 'X-Workforce-Client': 'web' },
      body: JSON.stringify({ activity: 'BLOCKED', note: 'waiting on staging access' }),
    });
    expect(res.status).toBe(200);
    const st = await one(db, sql`SELECT activity, provenance FROM agent_states WHERE employee_id = 'ben'`);
    expect(st).toEqual({ activity: 'BLOCKED', provenance: 'SELF_REPORTED' });
  });
});
