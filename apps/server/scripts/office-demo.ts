/**
 * Sends a few signed webhooks with "now" timestamps, so you can watch specific agents react:
 * a review (→ review table), a failed CI run (→ CI monitors), an issue (→ triage board) and a merge (→ ship bell).
 *   pnpm tsx scripts/office-demo.ts
 */
import { randomUUID } from 'node:crypto';
import { loadEnv } from '../src/config/env';
import { signGithubPayload } from '../src/github/verify';
import { DEMO_PEOPLE, DEMO_REPOS } from './lib/demo-org';
import { type PrState, prEvent, reviewEvent, workflowRunEvent } from './lib/github-payloads';

const env = loadEnv();
const url = process.env.WEBHOOK_URL ?? `http://localhost:${env.PORT}/webhooks/github`;
const who = (login: string) => DEMO_PEOPLE.find((p) => p.gh.login === login)!.gh;

async function send(ev: { eventType: string; payload: unknown }) {
  const body = JSON.stringify(ev.payload);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-GitHub-Event': ev.eventType,
      'X-GitHub-Delivery': randomUUID(),
      'X-Hub-Signature-256': signGithubPayload(body, env.GITHUB_WEBHOOK_SECRET),
    },
    body,
  });
  console.log(ev.eventType, res.status);
}

async function main() {
  const now = new Date();
  const repo = DEMO_REPOS[0];
  const n = 5000 + Math.floor(Math.random() * 1000);
  const pr: PrState = { repo, number: n, title: 'Office demo change', author: who('tanvir-a'), createdAt: new Date(now.getTime() - 3600e3), updatedAt: now, headSha: randomUUID().replace(/-/g, '') };

  await send(prEvent('opened', pr, pr.author));
  await send(reviewEvent(pr, who('arif-h'), Date.now(), 'approved', now));
  await send(reviewEvent(pr, who('priya-n'), Date.now() + 1, 'commented', now));
  await send(
    workflowRunEvent(repo, { id: Date.now(), name: 'CI', headSha: pr.headSha, branch: `feature/${n}`, conclusion: 'failure', startedAt: new Date(now.getTime() - 300e3), completedAt: now, actor: who('leo-m'), prNumbers: [n] }),
  );
  await send({
    eventType: 'issues',
    payload: {
      action: 'opened',
      issue: { id: Date.now(), number: n, title: 'Export button does nothing on Safari', html_url: `https://github.com/${repo.full_name}/issues/${n}`, created_at: now.toISOString(), updated_at: now.toISOString(), labels: [{ name: 'bug' }] },
      repository: { id: repo.id, full_name: repo.full_name, private: true, default_branch: 'main' },
      sender: { id: who('omar-f').id, login: 'omar-f', type: 'User' },
    },
  });
  await new Promise((r) => setTimeout(r, 2500));
  await send(prEvent('closed', { ...pr, updatedAt: new Date(), mergedAt: new Date(), mergedBy: who('tanvir-a') }, who('tanvir-a')));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
