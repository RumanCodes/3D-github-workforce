import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runBackfill, GithubClient } from '../src/github/backfill';
import { insertRawIfNew } from '../src/ingestion/raw-store';
import { deriveActivity } from '../src/presence/derive-activity';
vi.mock('../src/ingestion/raw-store', () => ({ insertRawIfNew: vi.fn(async () => 'raw-id') }));
vi.mock('../src/ingestion/process-raw-event', () => ({ processRawEvent: vi.fn(async () => ({ inserted: 1 })) }));
const now = new Date();
function client() {
 return { get: vi.fn(async (path: string) => {
  if (path === '/repos/example-org/example') return { data: { id: 123, full_name: 'example-org/example' }, next: null };
  if (path.includes('/pulls/comments?') || path.includes('/events?')) return { data: [], next: null };
  if (path.includes('/pulls?')) return { data: [], next: null };
  if (path.includes('/actions/runs?')) return { data: { workflow_runs: [] }, next: null };
  if (path.includes('/issues?')) return { data: [{ id: 1, number: 1, created_at: now.toISOString(), user: { id: 10, login: 'demo-user' } }, { id: 2, pull_request: {}, created_at: now.toISOString() }], next: null };
  if (path.includes('/releases?')) return { data: [{ id: 3, draft: false, published_at: now.toISOString(), author: { id: 10, login: 'demo-user' } }], next: null };
  throw new Error(`Unexpected request ${path}`);
 }) } as unknown as GithubClient;
}
beforeEach(() => vi.clearAllMocks());
describe('local contribution polling', () => {
 it('marks initial history as imported and skips PRs in the issue response', async () => {
  await runBackfill({} as any, client(), 'example-org/example', 1);
  expect(vi.mocked(insertRawIfNew).mock.calls.map(c => [c[1].source, c[1].eventType])).toEqual([['GITHUB_BACKFILL','issues'],['GITHUB_BACKFILL','release']]);
 });
 it('uses a distinct raw source for live API polling', async () => {
  await runBackfill({} as any, client(), 'example-org/example', 1, () => {}, { live: true, since: new Date(now.getTime()-60000) });
  expect(vi.mocked(insertRawIfNew).mock.calls.every(c=>c[1].source==='GITHUB_POLL')).toBe(true);
 });
 it('animates fresh polling only when explicitly identified as live', () => {
  const event = { verb: 'review.submitted', provenance: 'POLLED' as const, occurredAt: now, data: {} };
  expect(deriveActivity(event, now)).toBeNull();
  expect(deriveActivity(event, now, true)?.provenance).toBe('INFERRED');
  expect(deriveActivity({...event,occurredAt:new Date(0)},now,true)).toBeNull();
 });
});

describe('delayed GitHub push events',()=>{
 it('imports delayed pushes without inventing commit counts or fetching unreachable comparison SHAs',async()=>{
  const base=client();const original=base.get.bind(base);
  base.get=vi.fn(async(path:string)=> path.includes('/events?') ? {data:[{id:'delayed-push',type:'PushEvent',created_at:new Date(now.getTime()-3600000).toISOString(),actor:{id:99,login:'pusher'},payload:{head:'abc123',before:'000000',ref:'refs/heads/feature'}}],next:null}:original(path)) as any;
  await runBackfill({} as any,base,'example-org/example',1,()=>{},{live:true,since:new Date(now.getTime()-120000)});
  const call=vi.mocked(insertRawIfNew).mock.calls.find(c=>c[1].eventType==='push');
  expect(call).toBeTruthy();expect((call![1].payload as any).sender.login).toBe('pusher');expect((call![1].payload as any).workforce_push_count_unknown).toBe(true);
 });
});
