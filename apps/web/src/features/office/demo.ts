import type { Activity, AgentStateDTO, FeedEvent, OfficeLayout, RealtimeMessage } from '@workforce/contracts';

export const DEMO_TEAMS = ['Forms', 'Commerce', 'CRM', 'Community', 'Booking', 'Platform'];
const NAMES = ['Ari', 'Maya', 'Noor', 'Leo', 'Sam', 'Ira', 'Remy', 'Alex'];
const SURNAMES = ['River', 'Chen', 'Morgan', 'Patel', 'Santos', 'Kim'];
export const SCENARIOS = [
  { activity: 'CODING', verb: 'code.pushed', text: 'pushed a validation improvement' },
  { activity: 'REVIEWING', verb: 'review.submitted', text: 'reviewed the accessibility update' },
  { activity: 'FIXING_CI', verb: 'ci.completed', text: 'triggered a workflow that failed' },
  { activity: 'TRIAGING', verb: 'issue.opened', text: 'opened an issue about keyboard navigation' },
  { activity: 'MERGING', verb: 'pr.merged', text: 'merged the performance improvement' },
  { activity: 'RELEASING', verb: 'release.published', text: 'published a product release' },
] as const;

export function createDemo(count = 48, now = Date.now()) {
  const products = DEMO_TEAMS.map((team, i) => ({
    id: `demo-product-${i}`,
    name: `${team} · demo`,
    openPrs: 4 + i,
    awaitingReview: 1 + (i % 3),
    failingCi: i % 2,
    latestRelease: `Demo release 2.${i}.0`,
    repositories: [`demo-company/${team.toLowerCase()}`],
  }));
  const agents: AgentStateDTO[] = Array.from({ length: count }, (_, i) => ({
    employeeId: `demo-person-${i}`,
    name: `${NAMES[i % 8]} ${SURNAMES[Math.floor(i / 8) % 6]}${i >= 48 ? ` ${Math.floor(i / 48) + 1}` : ''}`,
    avatarUrl: null,
    team: DEMO_TEAMS[i % 6],
    activity: 'NONE',
    provenance: 'INFERRED',
    source: null,
    expiresAt: null,
  }));
  const layout: OfficeLayout = {
    desks: agents.map((a, i) => ({
      employeeId: a.employeeId,
      seat: i + 1,
      zone: [...DEMO_TEAMS].sort().indexOf(a.team!),
      slot: Math.floor(i / 6),
    })),
    products,
    repositories: products.map((p, i) => ({
      id: `demo-repo-${i}`,
      name: p.repositories[0],
      productId: p.id,
      connected: false,
      lastPolledAt: null,
      pollError: null,
    })),
  };
  const feed: FeedEvent[] = agents.slice(0, 18).map((a, i) => demoEvent(a, i, now - (i + 1) * 45000).event);
  return { agents, feed, layout };
}
export function demoEvent(agent: AgentStateDTO, step: number, now = Date.now()) {
  const scenario = SCENARIOS[step % SCENARIOS.length];
  const repo = `demo-company/${(agent.team ?? 'Platform').toLowerCase()}`;
  const event: FeedEvent = {
    live: true,
    id: `demo-${now}-${step}`,
    actor: { id: agent.employeeId, name: agent.name, avatarUrl: null },
    verb: scenario.verb,
    occurredAt: new Date(now).toISOString(),
    provenance: 'POLLED',
    repo,
    subject: 'demo',
    url: null,
    summary: scenario.text,
  };
  const next: AgentStateDTO = {
    ...agent,
    activity: scenario.activity as Activity,
    provenance: 'INFERRED',
    source: { verb: event.verb, occurredAt: event.occurredAt, url: null, label: `Demo: ${scenario.text}` },
    expiresAt: new Date(now + 25000).toISOString(),
  };
  return { event, agent: next };
}
export function demoMessages(agent: AgentStateDTO, step: number, seq: number, now = Date.now()): RealtimeMessage[] {
  const next = demoEvent(agent, step, now);
  return [
    { type: 'event', seq: seq + 1, event: next.event },
    { type: 'agent', seq: seq + 2, agent: next.agent },
  ];
}
