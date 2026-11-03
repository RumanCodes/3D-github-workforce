/**
 * Local simulator: sends realistic, *signed* GitHub webhooks to the running server, so the whole
 * pipeline (signature check → raw store → queue → normalize → projections → outbox → sockets)
 * is exercised exactly as it will be with your real GitHub organization.
 *
 *   pnpm simulate                 # 45 days of history, then live activity every few seconds
 *   pnpm simulate --days 30 --no-live
 *   pnpm simulate --live-only
 */
import { randomUUID } from 'node:crypto';
import { loadEnv } from '../src/config/env';
import { signGithubPayload } from '../src/github/verify';
import { DEMO_BOT, DEMO_PEOPLE, DEMO_REPOS } from './lib/demo-org';
import {
  type GhRepo,
  type GhUser,
  type PrState,
  prEvent,
  pushEvent,
  releaseEvent,
  reviewEvent,
  reviewRequestedEvent,
  workflowRunEvent,
} from './lib/github-payloads';

type Ev = { eventType: string; payload: unknown };
type Step = { afterHours: number; emit: (at: Date) => Ev[] };

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(`--${n}`);
const opt = (n: string, d: number) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? Number(args[i + 1]) : d;
};
const DAYS = opt('days', 45);
const LIVE = !flag('no-live');
const LIVE_ONLY = flag('live-only');
const LIVE_INTERVAL_S = opt('interval', 4);

// ---------- deterministic randomness ----------
let seed = opt('seed', 42);
const rand = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
const chance = (p: number) => rand() < p;
const between = (a: number, b: number) => a + rand() * (b - a);
const lognormal = (median: number, spread = 0.9) => {
  const u = Math.max(1e-9, rand());
  const v = rand();
  return median * Math.exp(spread * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v));
};
const weighted = <T extends { authorWeight: number }>(xs: T[]) => {
  const total = xs.reduce((s, x) => s + x.authorWeight, 0);
  let r = rand() * total;
  for (const x of xs) if ((r -= x.authorWeight) <= 0) return x;
  return xs[xs.length - 1];
};
const sha = () => Array.from({ length: 40 }, () => '0123456789abcdef'[Math.floor(rand() * 16)]).join('');
const addH = (d: Date, h: number) => new Date(d.getTime() + h * 3_600_000);
/** Work does not happen on weekends: push weekend times to Monday morning. */
const workday = (d: Date) => {
  const day = d.getUTCDay();
  if (day === 6) return addH(d, 48 - d.getUTCHours() + 3);
  if (day === 0) return addH(d, 24 - d.getUTCHours() + 3);
  return d;
};

const people = DEMO_PEOPLE;
const reviewers = people.filter((p) => p.reviewer);
const teamOf = (login: string) => people.find((p) => p.gh.login === login)?.employee?.teamId ?? null;

const TITLES = [
  'Fix login redirect loop', 'Add rate limiting to public API', 'Refactor invoice generator', 'Cache user permissions',
  'Fix timezone bug in reports', 'Upgrade payment SDK', 'Add CSV export for orders', 'Improve search relevance',
  'Fix crash on empty cart', 'Add retry to webhook sender', 'Paginate audit log', 'Fix flaky checkout test',
  'Support dark mode in settings', 'Reduce bundle size of dashboard', 'Fix race in session refresh', 'Add 2FA backup codes',
  'Handle expired coupons', 'Fix N+1 query on projects page', 'Add health checks', 'Migrate jobs to BullMQ',
  'Fix customer-reported PDF export bug', 'Fix email template rendering', 'Add feature flag for new onboarding',
];
const WORKFLOWS = ['CI', 'Lint & typecheck', 'E2E'];

let prCounter: Record<number, number> = {};
let runId = 500_000;
let reviewId = 800_000;

function* prLifecycle(start: Date): Generator<Step, void, unknown> {
  const authorP = chance(0.06) ? null : weighted(people);
  const author: GhUser = authorP ? authorP.gh : DEMO_BOT;
  const isBot = !authorP;
  const isSupport = authorP?.employee?.teamId === 'team-support';
  const repo: GhRepo = isSupport ? pick([DEMO_REPOS[0], DEMO_REPOS[2]]) : pick(DEMO_REPOS);
  // Live-only runs start numbering high so they never collide with pull requests from an earlier history run.
  prCounter[repo.id] = (prCounter[repo.id] ?? (LIVE_ONLY ? 1000 : 100)) + 1;
  const lines = isBot ? Math.round(between(2, 30)) : Math.max(3, Math.round(lognormal(120, 1.1)));
  const draft = !isBot && chance(0.2);
  const s: PrState = {
    repo,
    number: prCounter[repo.id],
    title: isBot ? `Bump ${pick(['axios', 'zod', 'react', 'pg'])} to latest` : isSupport ? 'Fix customer-reported ' + pick(['export', 'billing', 'login', 'invoice']) + ' bug' : pick(TITLES),
    author,
    createdAt: start,
    updatedAt: start,
    draft,
    headSha: sha(),
    additions: Math.round(lines * 0.7),
    deletions: Math.round(lines * 0.3),
    requestedReviewers: [],
  };
  const branch = `feature/${s.number}`;
  const at = (d: Date) => {
    s.updatedAt = d;
    return d;
  };

  // Only recent pull requests get stuck; nothing in a real org sits abandoned for two months.
  const recent = Date.now() - start.getTime() < 10 * 86_400_000;
  let stuckOnCi = false;
  const ci = (attempt = 1, forceSuccess = false): Step[] => {
    const id = ++runId;
    const fail = !forceSuccess && chance(isBot ? 0.05 : 0.16);
    const wf = pick(WORKFLOWS);
    const dur = between(4, wf === 'E2E' ? 22 : 12) / 60;
    const steps: Step[] = [
      {
        afterHours: 0.05,
        emit: (d) => [workflowRunEvent(repo, { id, attempt, name: wf, headSha: s.headSha, branch, conclusion: fail ? 'failure' : 'success', startedAt: addH(d, -dur), completedAt: d, actor: author, prNumbers: [s.number] })],
      },
    ];
    if (fail && chance(0.45)) {
      // flaky: re-run passes on the same commit
      steps.push({
        afterHours: between(0.2, 1),
        emit: (d) => [workflowRunEvent(repo, { id, attempt: attempt + 1, name: wf, headSha: s.headSha, branch, conclusion: 'success', startedAt: addH(d, -dur), completedAt: d, actor: author, prNumbers: [s.number] })],
      });
    } else if (fail && recent && chance(0.3)) {
      // left failing: nobody has fixed it yet, so the pull request stays open with red checks
      stuckOnCi = true;
      return steps;
    } else if (fail) {
      steps.push({ afterHours: between(0.5, 3), emit: (d) => { at(d); s.headSha = sha(); return [prEvent('synchronize', s, author, { after: s.headSha })]; } });
      steps.push(...ci(1, true));
    }
    return steps;
  };

  if (!isBot) {
    yield { afterHours: -between(0.3, 2), emit: (d) => [pushEvent(repo, author, branch, s.headSha, Math.ceil(between(1, 6)), d)] };
  }
  yield { afterHours: 0, emit: (d) => [prEvent('opened', { ...s, createdAt: d, updatedAt: d }, author)] };
  s.createdAt = start;
  for (const st of ci()) yield st;
  if (stuckOnCi) return;

  if (draft) {
    yield { afterHours: between(1, 24), emit: (d) => { at(d); s.draft = false; return [prEvent('ready_for_review', s, author)]; } };
  }

  if (chance(0.04)) {
    yield { afterHours: between(48, 120), emit: (d) => { at(d); s.closedAt = d; return [prEvent('closed', s, author)]; } };
    return;
  }

  const sameTeam = reviewers.filter((r) => r.gh.id !== author.id && teamOf(r.gh.login) === teamOf(author.login));
  const pool = sameTeam.length && chance(0.75) ? sameTeam : reviewers.filter((r) => r.gh.id !== author.id);
  const r1 = pick(pool).gh;
  const others = pool.filter((p) => p.gh.id !== r1.id);
  const r2 = others.length && chance(0.3) ? pick(others).gh : null;
  const requested = [r1, ...(r2 ? [r2] : [])];
  yield {
    afterHours: 0.02,
    emit: (d) => {
      at(d);
      return requested.map((r) => {
        s.requestedReviewers = [...(s.requestedReviewers ?? []), r];
        return reviewRequestedEvent(s, author, r);
      });
    },
  };

  // A few pull requests stall after review is requested, which the "no activity" queue should catch.
  if (!isBot && recent && chance(0.1)) return;

  const sizeFactor = Math.pow(Math.max(lines, 10) / 120, 0.45);
  // Some PRs sit unreviewed for days, which is exactly what the attention view should surface.
  const pickup = Math.min(140, lognormal(4.5, 1.1) * sizeFactor + (chance(0.12) ? between(30, 110) : 0));
  const reviewer = r1;
  const outcome = isBot ? 'approve' : rand() < 0.25 ? 'changes' : rand() < 0.35 ? 'comment' : 'approve';
  const review = (state: 'approved' | 'changes_requested' | 'commented') => (d: Date) => {
    at(d);
    s.requestedReviewers = (s.requestedReviewers ?? []).filter((u) => u.id !== reviewer.id);
    return [reviewEvent(s, reviewer, ++reviewId, state, d)];
  };

  if (outcome === 'changes') {
    yield { afterHours: pickup, emit: review('changes_requested') };
    yield { afterHours: between(1, 8), emit: (d) => { at(d); s.headSha = sha(); s.additions = (s.additions ?? 0) + 15; return [prEvent('synchronize', s, author, { after: s.headSha })]; } };
    for (const st of ci(1, true)) yield st;
    yield { afterHours: between(0.5, 6), emit: review('approved') };
  } else if (outcome === 'comment') {
    yield { afterHours: pickup, emit: review('commented') };
    yield { afterHours: between(0.5, 4), emit: review('approved') };
  } else {
    yield { afterHours: pickup, emit: review('approved') };
  }

  const merger = chance(0.75) && !isBot ? author : reviewer;
  yield {
    afterHours: between(0.1, 5),
    emit: (d) => {
      at(d);
      s.mergedAt = d;
      s.mergedBy = merger;
      s.requestedReviewers = [];
      return [prEvent('closed', s, merger), pushEvent(repo, merger, 'main', sha(), 1, d)];
    },
  };
}

// ---------- delivery ----------
const env = loadEnv();
const url = process.env.WEBHOOK_URL ?? `http://localhost:${env.PORT}/webhooks/github`;
let sent = 0;
let failed = 0;

async function deliver(ev: Ev) {
  const body = JSON.stringify(ev.payload);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-GitHub-Event': ev.eventType,
      'X-GitHub-Delivery': randomUUID(),
      'X-Hub-Signature-256': signGithubPayload(body, env.GITHUB_WEBHOOK_SECRET),
      'User-Agent': 'GitHub-Hookshot/simulator',
    },
    body,
  });
  if (res.ok) sent++;
  else {
    failed++;
    if (failed < 5) console.error(`delivery failed ${res.status}: ${await res.text()}`);
  }
}

async function deliverAll(evs: Ev[], concurrency = 8) {
  let i = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (i < evs.length) await deliver(evs[i++]);
    }),
  );
}

type Live = { gen: Generator<Step, void, unknown>; next: Step };

async function main() {
  const now = new Date();
  const timeline: { at: Date; ev: Ev }[] = [];
  const livePool: Live[] = [];

  if (!LIVE_ONLY) {
    // ~5 PRs per working day
    for (let day = DAYS; day >= 0; day--) {
      const d = new Date(now.getTime() - day * 86_400_000);
      if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
      const n = Math.round(between(3, 8));
      for (let k = 0; k < n; k++) {
        let t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), Math.floor(between(3, 13)), Math.floor(between(0, 59))));
        if (t > now) continue;
        const gen = prLifecycle(t);
        for (let r = gen.next(); !r.done; r = gen.next()) {
          const step = r.value;
          t = step.afterHours < 0 ? addH(t, step.afterHours) : workday(addH(t, step.afterHours));
          if (t > now) {
            livePool.push({ gen, next: step });
            break;
          }
          for (const ev of step.emit(t)) timeline.push({ at: t, ev });
          if (step.afterHours < 0) t = addH(t, -step.afterHours);
        }
      }
    }
    // weekly releases
    for (let w = Math.floor(DAYS / 7); w >= 0; w--) {
      const at = workday(new Date(now.getTime() - w * 7 * 86_400_000 - 3 * 3_600_000));
      if (at > now) continue;
      for (const repo of DEMO_REPOS.slice(0, 2)) {
        timeline.push({ at, ev: releaseEvent(repo, pick([DEMO_PEOPLE[1].gh, DEMO_PEOPLE[5].gh]), 70_000 + w * 10 + repo.id, `v1.${40 - w}.0`, at) });
      }
    }
    timeline.sort((a, b) => a.at.getTime() - b.at.getTime());
    console.log(`Sending ${timeline.length} historical webhooks (${DAYS} days) to ${url} ...`);
    await deliverAll(timeline.map((x) => x.ev));
    console.log(`History done: ${sent} accepted, ${failed} failed. ${livePool.length} PRs still in progress.`);
  }

  if (!LIVE) return;
  console.log(`Live mode: one action every ~${LIVE_INTERVAL_S}s. Ctrl+C to stop.`);
  for (;;) {
    await new Promise((r) => setTimeout(r, between(0.5, 1.5) * LIVE_INTERVAL_S * 1000));
    if (livePool.length < 6 || chance(0.15)) {
      const gen = prLifecycle(new Date());
      const r = gen.next();
      if (!r.done) livePool.push({ gen, next: r.value });
    }
    const idx = Math.floor(rand() * livePool.length);
    const item = livePool[idx];
    const evs = item.next.emit(new Date());
    for (const ev of evs) await deliver(ev);
    const label = evs.map((e: any) => `${e.eventType}${e.payload.action ? '.' + e.payload.action : ''}`).join(', ');
    console.log(`${new Date().toLocaleTimeString()}  ${label}`);
    const r = item.gen.next();
    if (r.done) livePool.splice(idx, 1);
    else item.next = r.value;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
