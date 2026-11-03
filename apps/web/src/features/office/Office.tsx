'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createDemo, demoMessages, SCENARIOS } from './demo';
import { useLive, useLiveConnection } from '@/lib/live';
import { useMe } from '@/components/shell';
import { api } from '@/lib/api';
import { activityLabels, type OfficeLayout } from './office-model';
const Scene = dynamic(() => import('./OfficeScene3D'), {
  ssr: false,
  loading: () => (
    <div className="office-message" role="status">
      Opening your office…
    </div>
  ),
});
const Setup = dynamic(() => import('./OfficeSetup'), { loading: () => <p>Loading office setup…</p> });
type Panel = 'people' | 'activity' | 'person' | null;
export default function Office({ mode = 'demo' }: { mode?: 'demo' | 'github' }) {
  const isDemo = mode === 'demo';
  const queryClient = useQueryClient();
  useLiveConnection(!isDemo);
  const [demoCount, setDemoCount] = useState(48),
    [demoPaused, setDemoPaused] = useState(false);
  const demo = useMemo(() => createDemo(demoCount), [demoCount]);
  const step = useRef(0);
  const triggerDemo = (scenario?: number) => {
    const state = useLive.getState();
    const people = Object.values(state.agents);
    if (!people.length) return;
    const next = scenario ?? step.current;
    const messages = demoMessages(people[(step.current * 7) % people.length], next, state.lastSeq);
    state.apply(messages);
    const event = messages[0].type === 'event' ? messages[0].event : null;
    if (event)
      queryClient.setQueryData<OfficeLayout>(['office-layout', mode, demoCount], (old) =>
        old
          ? {
              ...old,
              products: old.products.map((p) =>
                !p.repositories.includes(event.repo ?? '')
                  ? p
                  : {
                      ...p,
                      openPrs: Math.max(0, (p.openPrs ?? 0) - (event.verb === 'pr.merged' ? 1 : 0)),
                      awaitingReview: Math.max(
                        0,
                        (p.awaitingReview ?? 0) - (event.verb === 'review.submitted' ? 1 : 0),
                      ),
                      failingCi: event.verb === 'ci.completed' ? (p.failingCi ?? 0) + 1 : p.failingCi,
                      latestRelease:
                        event.verb === 'release.published' ? 'Demo release just published' : p.latestRelease,
                    },
              ),
            }
          : old,
      );
    step.current++;
  };
  useEffect(() => {
    if (!isDemo) return;
    useLive.setState({ lastSeq: 0, conn: 'live' });
    useLive.getState().seed(demo.feed, demo.agents);
    queryClient.setQueryData(['office-layout', mode, demoCount], demo.layout);
    return () => {
      useLive.getState().seed([], []);
      useLive.setState({ lastSeq: 0, conn: 'connecting' });
    };
  }, [isDemo, demo]);
  useEffect(() => {
    if (!isDemo || demoPaused) return;
    const timer = setInterval(() => {
      if (!document.hidden) triggerDemo();
    }, 7000);
    return () => clearInterval(timer);
  }, [isDemo, demoPaused, demo]);
  const agents = useLive((s) => s.agents),
    feed = useLive((s) => s.feed),
    conn = useLive((s) => s.conn);
  const me = useMe(!isDemo);
  const [search, setSearch] = useState(''),
    [team, setTeam] = useState(''),
    [product, setProduct] = useState('');
  const [selected, setSelected] = useState<string | null>(null),
    [reset, setReset] = useState(0),
    [panel, setPanel] = useState<Panel>(null);
  const [now, setNow] = useState(Date.now()),
    [logoutError, setLogoutError] = useState('');
  const [setupOpened, setSetupOpened] = useState(false);
  const setup = useRef<HTMLDialogElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (panel) closeButton.current?.focus();
  }, [panel]);
  const q = useQuery({
    queryKey: ['office-layout', mode, demoCount],
    queryFn: () => (isDemo ? Promise.resolve(demo.layout) : api.get<OfficeLayout>('/office/layout')),
    refetchInterval: isDemo ? false : 15000,
    staleTime: isDemo ? Infinity : 15000,
    refetchOnWindowFocus: !isDemo,
  });
  const all = Object.values(agents),
    teams = [...new Set(all.map((a) => a.team).filter((t): t is string => !!t))];
  const chosen = q.data?.products.find((p) => p.id === product);
  const filtered = all.filter(
    (a) =>
      (!team || a.team === team) &&
      a.name.toLowerCase().includes(search.toLowerCase()) &&
      (!chosen || feed.some((e) => e.actor?.id === a.employeeId && chosen.repositories.includes(e.repo ?? ''))),
  );
  const lastSync = q.data?.repositories
    .map((r) => r.lastPolledAt)
    .filter((t): t is string => !!t)
    .sort()
    .at(-1);
  const syncErrors = q.data?.repositories.filter((r) => r.pollError).length ?? 0;
  const person = selected ? agents[selected] : null;
  const events = feed
    .filter(
      (e) =>
        (panel !== 'person' || e.actor?.id === selected) && (!chosen || chosen.repositories.includes(e.repo ?? '')),
    )
    .slice(0, 30);
  const select = (id: string) => {
    setSelected(id);
    setPanel('person');
  };
  const toggle = (next: Panel) => {
    setPanel(panel === next ? null : next);
    if (next !== 'person') setSelected(null);
  };
  return (
    <main
      className="office-stage"
      aria-label="3D workforce office"
      onKeyDown={(e) => {
        if (e.key === 'Escape') setPanel(null);
      }}
    >
      <div className="office-world">
        {q.data && (
          <Scene
            agents={all}
            visibleIds={filtered.map((a) => a.employeeId)}
            demo={isDemo}
            layout={q.data}
            selected={selected}
            onSelect={select}
            reset={reset}
            onProduct={(id) => {
              setProduct(id);
              setSelected(null);
              setPanel('activity');
            }}
            onUnavailable={() => setPanel('people')}
          />
        )}
      </div>
      <header className="office-topbar">
        <div className="office-brand">
          <span className="office-brand-mark" aria-hidden="true">
            W
          </span>
          <div>
            <h1>Workforce</h1>
            <span>{isDemo ? 'Demo office · fictional activity' : 'Connected GitHub office · read-only'}</span>
          </div>
        </div>
        <div className="office-toolbar" aria-label="Office controls">
          <button aria-expanded={panel === 'people'} onClick={() => toggle('people')}>
            People <span className="office-count">{all.length}</span>
          </button>
          <button aria-expanded={panel === 'activity'} onClick={() => toggle('activity')}>
            Activity
          </button>
          <button
            onClick={() => {
              setSelected(null);
              setReset((n) => n + 1);
              setSearch('');
              setTeam('');
              setProduct('');
              setPanel(null);
            }}
          >
            Reset view
          </button>
        </div>
        <div className="office-account">
          {!isDemo && me.data?.role === 'ADMIN' && (
            <button
              onClick={() => {
                setSetupOpened(true);
                setup.current?.showModal();
              }}
            >
              Office setup
            </button>
          )}
          {isDemo ? (
            <button
              className="office-connect"
              onClick={() => {
                setSetupOpened(true);
                setup.current?.showModal();
              }}
            >
              Connect GitHub ↗
            </button>
          ) : (
            <button
              title={me.data?.displayName ?? 'Account'}
              onClick={async () => {
                try {
                  await api.post('/auth/logout');
                  location.href = '/login';
                } catch {
                  setLogoutError('Could not sign out. Please try again.');
                }
              }}
            >
              Sign out
            </button>
          )}
        </div>
      </header>
      <div className="office-filters">
        <label>
          <span className="sr-only">Team</span>
          <select
            value={team}
            onChange={(e) => {
              setTeam(e.target.value);
              setSelected(null);
              setPanel(null);
            }}
          >
            <option value="">All teams</option>
            {teams.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </label>
        <label>
          <span className="sr-only">Product</span>
          <select
            value={product}
            onChange={(e) => {
              setProduct(e.target.value);
              setSelected(null);
              setPanel(e.target.value ? 'activity' : null);
            }}
          >
            <option value="">All products</option>
            {q.data?.products.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {isDemo && (
        <div className="office-demo-controls">
          <span>Demo controls</span>
          <button onClick={() => setDemoPaused((v) => !v)}>{demoPaused ? 'Resume' : 'Pause'}</button>
          <select
            aria-label="Demo office size"
            value={demoCount}
            onChange={(e) => {
              setDemoCount(Number(e.target.value));
              setSelected(null);
              setReset((n) => n + 1);
            }}
          >
            <option value={48}>48 people</option>
            <option value={150}>150 people</option>
          </select>
          <select
            aria-label="Simulate activity"
            defaultValue=""
            onChange={(e) => {
              if (e.target.value !== '') triggerDemo(Number(e.target.value));
              e.target.value = '';
            }}
          >
            <option value="" disabled>
              Simulate activity…
            </option>
            {SCENARIOS.map((s, i) => (
              <option key={s.verb} value={i}>
                {activityLabels[s.activity]}
              </option>
            ))}
          </select>
        </div>
      )}
      {q.isLoading && (
        <div className="office-message" role="status">
          Preparing the office…
        </div>
      )}
      {q.isError && (
        <div className="office-message" role="alert">
          <p>We couldn’t load the office.</p>
          <button onClick={() => q.refetch()}>Try again</button>
        </div>
      )}
      {!q.isLoading && !q.isError && filtered.length === 0 && (
        <div className="office-empty">
          <h2>{all.length ? 'No matching teammates' : 'Your office is ready to fill'}</h2>
          <p>
            {all.length
              ? 'Choose another team or product, or clear your search.'
              : 'Connect GitHub and add your team from Office setup.'}
          </p>
        </div>
      )}
      {logoutError && (
        <p className="office-error" role="alert">
          {logoutError}
        </p>
      )}
      {panel && (
        <aside
          className="office-drawer"
          aria-label={
            panel === 'people'
              ? 'People in the office'
              : panel === 'person'
                ? 'Teammate contributions'
                : 'Office activity'
          }
        >
          <div className="office-drawer-heading">
            <div>
              <h2>{panel === 'people' ? 'People' : person && panel === 'person' ? person.name : 'Office activity'}</h2>
              <p>{panel === 'people' ? 'Find a teammate and visit their desk.' : 'Recent GitHub contributions'}</p>
            </div>
            <button ref={closeButton} aria-label="Close panel" onClick={() => setPanel(null)}>
              ✕
            </button>
          </div>
          {panel === 'people' ? (
            <>
              <label className="office-search">
                <span className="sr-only">Search teammates</span>
                <input
                  type="search"
                  placeholder="Find a teammate…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </label>
              <ul className="office-roster">
                {filtered.map((a) => (
                  <li key={a.employeeId}>
                    <button onClick={() => select(a.employeeId)}>
                      <span className="office-initial" aria-hidden="true">
                        {a.name.slice(0, 1)}
                      </span>
                      <span>
                        <strong>{a.name}</strong>
                        <small>
                          {a.team ?? 'Unassigned'} ·{' '}
                          {activityLabels[a.expiresAt && Date.parse(a.expiresAt) > now ? a.activity : 'NONE']}
                        </small>
                      </span>
                      <span aria-hidden="true">↗</span>
                    </button>
                  </li>
                ))}
              </ul>
              {!filtered.length && <p className="office-panel-note">No teammates match your filters.</p>}
            </>
          ) : (
            <>
              {chosen && (
                <div className="office-product-detail">
                  <h3>{chosen.name}</h3>
                  <dl>
                    <div>
                      <dt>Open pull requests</dt>
                      <dd>{chosen.openPrs ?? '—'}</dd>
                    </div>
                    <div>
                      <dt>Awaiting first review</dt>
                      <dd>{chosen.awaitingReview ?? '—'}</dd>
                    </div>
                    <div>
                      <dt>Failing workflows</dt>
                      <dd>{chosen.failingCi ?? '—'}</dd>
                    </div>
                  </dl>
                  <p>{chosen.latestRelease ?? 'No release tracked yet'}</p>
                  <small>{isDemo ? 'Simulated product state' : 'Fetched repository state'}</small>
                </div>
              )}
              <ol className="office-events">
                {events.map((e) => (
                  <li key={e.id}>
                    <p>
                      {panel !== 'person' && <strong>{e.actor?.name ?? 'GitHub'} </strong>}
                      {e.summary}
                    </p>
                    <small>
                      {e.repo} · {new Date(e.occurredAt).toLocaleString()}
                    </small>
                    <div className="office-event-source">
                      <span>
                        {isDemo
                          ? 'Simulated'
                          : e.provenance === 'POLLED'
                            ? 'GitHub API'
                            : e.provenance === 'VERIFIED'
                              ? 'Verified'
                              : e.provenance}
                      </span>
                      {e.url && (
                        <a href={e.url} target="_blank" rel="noreferrer">
                          View on GitHub ↗
                        </a>
                      )}
                    </div>
                  </li>
                ))}
              </ol>
              {!events.length && <p className="office-panel-note">No recent tracked contributions.</p>}
            </>
          )}
          <p className="office-panel-note">GitHub activity shows contributions, not attendance.</p>
        </aside>
      )}
      <footer className="office-bottom">
        <span className="office-connection" role="status">
          <i data-live={conn === 'live'} />
          {isDemo
            ? 'Demo · no GitHub connection or writes'
            : conn === 'live'
              ? syncErrors
                ? `${syncErrors} repositories need attention · open Office setup`
                : lastSync
                  ? `Last GitHub sync ${new Date(lastSync).toLocaleTimeString()}`
                  : 'Connected · waiting for GitHub sync'
              : conn === 'connecting'
                ? 'Connecting to your office…'
                : 'Reconnecting · activity may be behind'}
        </span>
        <span className="office-camera-help">Drag to rotate · Scroll to zoom · Right-drag to pan</span>
      </footer>
      <dialog ref={setup} className="office-setup">
        <div className="office-setup-heading">
          <div>
            <h2>Office setup</h2>
            <p>Connect your products and bring your team into the office.</p>
          </div>
          <button aria-label="Close office setup" onClick={() => setup.current?.close()}>
            ✕
          </button>
        </div>
        {isDemo ? (
          <div className="office-connect-guide">
            <p>
              This office only reads GitHub. It cannot push code, edit issues, submit reviews or change repository
              settings.
            </p>
            <ol>
              <li>
                Create a GitHub App for your organization with read-only Contents, Metadata, Pull requests, Issues, Actions
                and organization Members permissions. Disable webhooks for local polling.
              </li>
              <li>
                Install it on your selected repositories. Save the App ID and private-key path in{' '}
                <code>apps/server/.env</code>.
              </li>
              <li>
                Run <code>pnpm local:setup</code>, then <code>pnpm dev</code>. Open the connected office and sign in
                locally as the configured administrator.
              </li>
              <li>
                Choose Office setup → Sync GitHub installation. Members, teams, products and contributions will be
                fetched into the local cache.
              </li>
            </ol>
            <p>Demo employees are fictional and never copied into your connected office.</p>
            <a href="/office?source=github">Open connected office ↗</a>
          </div>
        ) : (
          setupOpened && me.data?.role === 'ADMIN' && <Setup />
        )}
      </dialog>
    </main>
  );
}
