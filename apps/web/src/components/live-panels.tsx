'use client';

import type { Activity, AgentStateDTO } from '@workforce/contracts';
import clsx from 'clsx';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { ago, clock } from '@/lib/format';
import { useLive } from '@/lib/live';
import { Avatar, Empty, Panel, ProvenanceMark } from './ui';

const ACTIVITY: Record<Activity, { label: string; tone: string }> = {
  CODING: { label: 'Coding', tone: 'text-signal' },
  REVIEWING: { label: 'Reviewing', tone: 'text-signal' },
  MERGING: { label: 'Merging', tone: 'text-signal' },
  RELEASING: { label: 'Releasing', tone: 'text-signal' },
  TRIAGING: { label: 'Triaging issues', tone: 'text-signal' },
  CELEBRATING: { label: 'Shipped', tone: 'text-signal' },
  FIXING_CI: { label: 'CI failed on their run', tone: 'text-fail' },
  BLOCKED: { label: 'Blocked', tone: 'text-wait' },
  NONE: { label: 'No recent tracked activity', tone: 'text-ink-3' },
};

/** Re-render every 20 s so inferred states disappear when they expire. */
function useNow(ms = 20_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

const current = (a: AgentStateDTO, now: number): Activity =>
  a.activity !== 'NONE' && a.expiresAt && new Date(a.expiresAt).getTime() > now ? a.activity : 'NONE';

export function TeamRoster() {
  const agents = useLive((s) => s.agents);
  const now = useNow();
  const list = useMemo(() => Object.values(agents), [agents]);
  const active = list.filter((a) => current(a, now) !== 'NONE').sort((a, b) => (b.source?.occurredAt ?? '').localeCompare(a.source?.occurredAt ?? ''));
  const quiet = list.filter((a) => current(a, now) === 'NONE');

  return (
    <Panel title="Who’s working on what" aside={`${active.length} active now`}>
      {list.length === 0 ? (
        <Empty>No employees yet. An admin can add people, or they appear when they sign in with GitHub.</Empty>
      ) : (
        <>
          <ul className="divide-y divide-line">
            {active.map((a) => {
              const act = current(a, now);
              return (
                <li key={a.employeeId} className="flex items-start gap-3 px-4 py-3">
                  <Avatar name={a.name} url={a.avatarUrl} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <Link href={`/people/${a.employeeId}`} className="truncate font-medium hover:underline">
                        {a.name}
                      </Link>
                      <span className={clsx('shrink-0 text-sm font-medium', ACTIVITY[act].tone)}>{ACTIVITY[act].label}</span>
                    </div>
                    {a.source && (
                      <div className="mt-0.5 flex items-start gap-1.5 text-sm text-ink-3">
                        <span className="pt-[3px]">
                          <ProvenanceMark p={a.provenance} />
                        </span>
                        <span className="min-w-0">
                          {a.source.url ? (
                            <a href={a.source.url} target="_blank" rel="noreferrer" className="hover:underline">
                              {a.source.label}
                            </a>
                          ) : (
                            a.source.label
                          )}{' '}
                          <span className="whitespace-nowrap">{ago(a.source.occurredAt, now)}</span>
                        </span>
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
          {quiet.length > 0 && (
            <div className="border-t border-line px-4 py-3">
              <p className="mb-2 text-sm text-ink-3">No recent tracked activity</p>
              <div className="flex flex-wrap gap-1.5">
                {quiet.map((a) => (
                  <Link key={a.employeeId} href={`/people/${a.employeeId}`} title={`${a.name}${a.team ? `, ${a.team}` : ''}`}>
                    <Avatar name={a.name} url={a.avatarUrl} size={26} />
                  </Link>
                ))}
              </div>
              <p className="mt-2 text-xs text-ink-3">
                Quiet here only means no GitHub events in the last few minutes, not that someone isn’t working.
              </p>
            </div>
          )}
        </>
      )}
    </Panel>
  );
}

export function ActivityFeed({ limit = 25 }: { limit?: number }) {
  const feed = useLive((s) => s.feed);
  const fresh = useLive((s) => s.freshIds);
  const now = useNow(30_000);
  const items = feed.slice(0, limit);
  return (
    <Panel
      title="Activity"
      aside={
        <span className="inline-flex items-center gap-3">
          <ProvenanceMark p="VERIFIED" showLabel />
          <ProvenanceMark p="POLLED" showLabel />
        </span>
      }
    >
      {items.length === 0 ? (
        <Empty>Nothing yet. Activity appears here as soon as GitHub sends the first webhook.</Empty>
      ) : (
        <ol className="divide-y divide-line" aria-live="polite" aria-relevant="additions">
          {items.map((e) => (
            <li key={e.id} className={clsx('flex gap-3 px-4 py-2.5', fresh.has(e.id) && 'arrive')}>
              <span className="pt-1.5">
                <ProvenanceMark p={e.provenance} />
              </span>
              <div className="min-w-0 flex-1 text-sm">
                <span className="font-medium">{e.actor?.name ?? 'GitHub'}</span>{' '}
                {e.url ? (
                  <a href={e.url} target="_blank" rel="noreferrer" className="text-ink-2 hover:underline">
                    {e.summary}
                  </a>
                ) : (
                  <span className="text-ink-2">{e.summary}</span>
                )}
              </div>
              <time dateTime={e.occurredAt} title={new Date(e.occurredAt).toLocaleString()} className="shrink-0 text-xs text-ink-3">
                {now - new Date(e.occurredAt).getTime() < 86_400_000 ? clock(e.occurredAt) : ago(e.occurredAt, now)}
              </time>
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}
