'use client';

import OfficeAdmin from '@/features/office/OfficeAdmin';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { PageHeader } from '@/components/shell';
import { Avatar, Button, Empty, ErrorNote, Loading, Panel } from '@/components/ui';
import { api } from '@/lib/api';
import { ago } from '@/lib/format';

type Health = {
  rawLast7Days: Record<string, number>;
  failed: { id: string; eventType: string; source: string; receivedAt: string; error: string; attempts: number }[];
  lastWebhookAt: string | null;
  lastBackfillAt: string | null;
  outboxBacklog: number;
  queues: { normalize: Record<string, number>; backfill: Record<string, number> };
  repositories: { name: string; lastEventAt: string | null; events: number }[];
  backfillAvailable: boolean;
};
type Identity = { githubId: string; handle: string; avatarUrl: string | null; verifiedBy: string | null; employeeId: string | null; employeeName: string | null; events: number };
type Employees = {
  employees: { id: string; displayName: string; email: string | null; role: string; active: boolean; teamId: string | null; team: string | null; githubLogins: string[] }[];
  teams: { id: string; name: string; department: string }[];
};

const input = 'h-9 rounded-md border border-line bg-surface px-2 text-sm';

function Status() {
  const q = useQuery({ queryKey: ['admin-health'], queryFn: () => api.get<Health>('/admin/health'), refetchInterval: 15_000 });
  const qc = useQueryClient();
  const replay = useMutation({ mutationFn: () => api.post<{ requeued: number }>('/admin/replay'), onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-health'] }) });
  const [repo, setRepo] = useState('');
  const [days, setDays] = useState(60);
  const backfill = useMutation({ mutationFn: () => api.post<{ jobId: string }>('/admin/backfill', { repo: repo.trim(), days }) });
  const h = q.data;
  const stale = h?.lastWebhookAt && Date.now() - new Date(h.lastWebhookAt).getTime() > 6 * 3_600_000;

  return (
    <Panel title="GitHub connection">
      {q.isLoading && <Loading />}
      {q.error && <ErrorNote error={q.error} />}
      {h && (
        <div className="space-y-5 p-4">
          <dl className="grid gap-4 sm:grid-cols-4">
            <div>
              <dt className="text-sm text-ink-3">Last webhook</dt>
              <dd className={stale ? 'font-medium text-wait' : 'font-medium'}>{h.lastWebhookAt ? ago(h.lastWebhookAt) : 'Never'}</dd>
            </div>
            <div>
              <dt className="text-sm text-ink-3">Processed (7 days)</dt>
              <dd className="font-medium">{h.rawLast7Days.NORMALIZED ?? 0}</dd>
            </div>
            <div>
              <dt className="text-sm text-ink-3">Waiting in queue</dt>
              <dd className="font-medium">{(h.queues.normalize.waiting ?? 0) + (h.queues.normalize.active ?? 0) + (h.queues.normalize.delayed ?? 0)}</dd>
            </div>
            <div>
              <dt className="text-sm text-ink-3">Failed to process</dt>
              <dd className={h.failed.length ? 'font-medium text-fail' : 'font-medium'}>{h.failed.length}</dd>
            </div>
          </dl>
          {!h.lastWebhookAt && (
            <p className="text-sm text-ink-2">
              No webhooks yet. In your GitHub organization settings, add a webhook (or GitHub App) pointing to{' '}
              <code className="font-mono text-xs">https://your-server/webhooks/github</code> with the shared secret, content type JSON,
              and these events: pull requests, pull request reviews, review comments, workflow runs, pushes, releases, issues.
            </p>
          )}
          {stale && <p className="text-sm text-wait">No webhook in over 6 hours. Check the webhook’s recent deliveries in GitHub.</p>}
          {h.failed.length > 0 && (
            <div>
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-sm font-medium">Failed events</h3>
                <Button onClick={() => replay.mutate()} disabled={replay.isPending}>
                  Retry failed events
                </Button>
              </div>
              <ul className="divide-y divide-line rounded-md border border-line text-sm">
                {h.failed.slice(0, 8).map((f) => (
                  <li key={f.id} className="px-3 py-2">
                    <span className="font-medium">{f.eventType}</span> <span className="text-ink-3">{ago(f.receivedAt)}</span>
                    <div className="truncate text-xs text-fail">{f.error}</div>
                  </li>
                ))}
              </ul>
              {replay.data && <p className="mt-2 text-sm text-ink-2">Requeued {replay.data.requeued} events.</p>}
            </div>
          )}
          <div>
            <h3 className="mb-2 text-sm font-medium">Import history from a repository</h3>
            {h.backfillAvailable ? (
              <form
                className="flex flex-wrap items-center gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  backfill.mutate();
                }}
              >
                <input className={`${input} w-64`} value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="your-org/repository" aria-label="Repository" />
                <select className={input} value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="How far back">
                  <option value={30}>Last 30 days</option>
                  <option value={60}>Last 60 days</option>
                  <option value={90}>Last 90 days</option>
                </select>
                <Button type="submit" variant="primary" disabled={!repo.includes('/') || backfill.isPending}>
                  Import history
                </Button>
                {backfill.data && <span className="text-sm text-ink-2">Import started. Imported events are marked as imported, not live.</span>}
                {backfill.error && <span className="text-sm text-fail">{(backfill.error as Error).message}</span>}
              </form>
            ) : (
              <p className="text-sm text-ink-3">Set GITHUB_TOKEN on the server (read access to your repositories) to import past pull requests, reviews and CI runs.</p>
            )}
          </div>
          {h.repositories.length > 0 && (
            <div>
              <h3 className="mb-2 text-sm font-medium">Repositories seen</h3>
              <ul className="grid gap-x-6 text-sm sm:grid-cols-2">
                {h.repositories.map((r) => (
                  <li key={r.name} className="flex justify-between border-b border-line py-1.5">
                    <span className="font-mono text-xs">{r.name}</span>
                    <span className="text-ink-3">
                      {r.events} events, last {ago(r.lastEventAt)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </Panel>
  );
}

function Identities({ employees }: { employees: Employees['employees'] }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['admin-identities'], queryFn: () => api.get<Identity[]>('/admin/identities') });
  const [choice, setChoice] = useState<Record<string, string>>({});
  const link = useMutation({
    mutationFn: (b: { githubId: string; employeeId: string }) => api.post<{ reattributedEvents: number }>('/admin/identities/link', b),
    onSuccess: () => qc.invalidateQueries(),
  });
  const unlinked = (q.data ?? []).filter((i) => !i.employeeId);
  const linked = (q.data ?? []).filter((i) => i.employeeId);
  return (
    <Panel title="GitHub accounts" aside={unlinked.length ? `${unlinked.length} not linked` : 'All linked'}>
      {q.isLoading && <Loading />}
      {q.error && <ErrorNote error={q.error} />}
      {q.data && (
        <>
          <p className="px-4 pt-3 text-sm text-ink-2">
            Activity from an unlinked account is recorded but not credited to anyone. Linking credits all of its past activity too.
          </p>
          {unlinked.length === 0 ? (
            <Empty>Every GitHub account seen so far is linked to an employee.</Empty>
          ) : (
            <ul className="divide-y divide-line">
              {unlinked.map((i) => (
                <li key={i.githubId} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
                  <Avatar name={i.handle} url={i.avatarUrl} />
                  <div className="min-w-[160px] flex-1">
                    <div className="font-medium">{i.handle}</div>
                    <div className="text-xs text-ink-3">{i.events} events</div>
                  </div>
                  <select
                    className={input}
                    aria-label={`Employee for ${i.handle}`}
                    value={choice[i.githubId] ?? ''}
                    onChange={(e) => setChoice({ ...choice, [i.githubId]: e.target.value })}
                  >
                    <option value="">Choose an employee</option>
                    {employees.filter((e) => e.active).map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.displayName}
                      </option>
                    ))}
                  </select>
                  <Button
                    disabled={!choice[i.githubId] || link.isPending}
                    onClick={() => link.mutate({ githubId: i.githubId, employeeId: choice[i.githubId] })}
                  >
                    Link account
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {link.data && <p className="px-4 pb-3 text-sm text-ink-2">Linked. {link.data.reattributedEvents} past events are now credited.</p>}
          {linked.length > 0 && (
            <details className="border-t border-line px-4 py-3 text-sm">
              <summary className="cursor-pointer text-ink-2">{linked.length} linked accounts</summary>
              <ul className="mt-2 grid gap-x-6 sm:grid-cols-2">
                {linked.map((i) => (
                  <li key={i.githubId} className="flex justify-between border-b border-line py-1.5">
                    <span>{i.handle}</span>
                    <span className="text-ink-3">
                      {i.employeeName}
                      {i.verifiedBy === 'OAUTH' ? ', signed in' : ''}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </Panel>
  );
}

function People({ data }: { data: Employees }) {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [teamId, setTeamId] = useState('');
  const [teamName, setTeamName] = useState('');
  const [dept, setDept] = useState('Development');
  const done = () => qc.invalidateQueries();
  const add = useMutation({ mutationFn: () => api.post('/admin/employees', { displayName: name.trim(), teamId: teamId || null }), onSuccess: () => { setName(''); done(); } });
  const addTeam = useMutation({ mutationFn: () => api.post('/admin/teams', { name: teamName.trim(), department: dept }), onSuccess: () => { setTeamName(''); done(); } });
  const update = useMutation({ mutationFn: (b: Record<string, unknown>) => api.post('/admin/employees/update', b), onSuccess: done });

  return (
    <Panel title="People and teams">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="border-b border-line text-left text-ink-3">
              <th className="px-4 py-2 font-medium">Name</th>
              <th className="px-4 py-2 font-medium">Team</th>
              <th className="px-4 py-2 font-medium">Access</th>
              <th className="px-4 py-2 font-medium">GitHub</th>
              <th className="px-4 py-2 font-medium" />
            </tr>
          </thead>
          <tbody>
            {data.employees.map((e) => (
              <tr key={e.id} className={`border-b border-line last:border-0 ${e.active ? '' : 'text-ink-3'}`}>
                <td className="px-4 py-2">{e.displayName}</td>
                <td className="px-4 py-2">
                  <select className={input} value={e.teamId ?? ''} aria-label={`Team for ${e.displayName}`} onChange={(ev) => update.mutate({ employeeId: e.id, teamId: ev.target.value || null })}>
                    <option value="">No team</option>
                    {data.teams.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="px-4 py-2">
                  <select className={input} value={e.role} aria-label={`Access for ${e.displayName}`} onChange={(ev) => update.mutate({ employeeId: e.id, role: ev.target.value })}>
                    <option value="MEMBER">Member</option>
                    <option value="LEAD">Team lead</option>
                    <option value="ADMIN">Admin</option>
                  </select>
                </td>
                <td className="px-4 py-2 text-ink-3">{e.githubLogins.join(', ') || 'Not linked'}</td>
                <td className="px-4 py-2 text-right">
                  <Button variant="quiet" onClick={() => update.mutate({ employeeId: e.id, active: !e.active })}>
                    {e.active ? 'Deactivate' : 'Reactivate'}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {update.error && <p className="px-4 py-2 text-sm text-fail">{(update.error as Error).message}</p>}
      <div className="grid gap-4 border-t border-line p-4 md:grid-cols-2">
        <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); add.mutate(); }}>
          <h3 className="text-sm font-medium">Add a person</h3>
          <div className="flex flex-wrap gap-2">
            <input className={`${input} flex-1`} value={name} onChange={(e) => setName(e.target.value)} placeholder="Full name" aria-label="Full name" />
            <select className={input} value={teamId} onChange={(e) => setTeamId(e.target.value)} aria-label="Team">
              <option value="">No team</option>
              {data.teams.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
            <Button type="submit" disabled={!name.trim() || add.isPending}>Add person</Button>
          </div>
          <p className="text-xs text-ink-3">People who sign in with GitHub are added automatically. Link their account above if they were added here first.</p>
        </form>
        <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); addTeam.mutate(); }}>
          <h3 className="text-sm font-medium">Add a team</h3>
          <div className="flex flex-wrap gap-2">
            <input className={`${input} flex-1`} value={teamName} onChange={(e) => setTeamName(e.target.value)} placeholder="Team name" aria-label="Team name" />
            <select className={input} value={dept} onChange={(e) => setDept(e.target.value)} aria-label="Department">
              {['Development', 'Support', 'UI/UX', 'Motion Graphics', 'Marketing'].map((d) => (
                <option key={d}>{d}</option>
              ))}
            </select>
            <Button type="submit" disabled={!teamName.trim() || addTeam.isPending}>Add team</Button>
          </div>
        </form>
      </div>
    </Panel>
  );
}

export default function OfficeSetup() {
  const emp = useQuery({ queryKey: ['admin-employees'], queryFn: () => api.get<Employees>('/admin/employees') });
  return (
    <div className="mx-auto max-w-[1100px] space-y-6">

      {emp.error && <ErrorNote error={emp.error} />}
      <OfficeAdmin />
      <Status />
      {emp.data && <Identities employees={emp.data.employees} />}
      {emp.data && <People data={emp.data} />}
    </div>
  );
}
