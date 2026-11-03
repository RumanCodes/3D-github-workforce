'use client';

import type { Provenance, PullRequestDTO } from '@workforce/contracts';
import clsx from 'clsx';
import { hours, initials } from '@/lib/format';

export function Avatar({ name, url, size = 28 }: { name: string; url?: string | null; size?: number }) {
  if (url) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={url} alt="" width={size} height={size} className="shrink-0 rounded-full bg-sunken" />;
  }
  return (
    <span
      aria-hidden
      style={{ width: size, height: size, fontSize: size * 0.4 }}
      className="inline-flex shrink-0 items-center justify-center rounded-full bg-sunken font-medium text-ink-2"
    >
      {initials(name)}
    </span>
  );
}

const PROVENANCE_TEXT: Record<Provenance, { label: string; help: string }> = {
  VERIFIED: { label: 'Verified', help: 'Sent by GitHub as it happened, signature checked.' },
  POLLED: { label: 'Imported', help: 'Read from GitHub’s history by a backfill; the time is GitHub’s, not live.' },
  SELF_REPORTED: { label: 'Reported', help: 'Entered by the person themselves.' },
  INFERRED: { label: 'Inferred', help: 'A best guess from a recent verified event. It expires after a few minutes.' },
};

/**
 * The trust mark used everywhere: solid = verified, outlined = imported, ring with person = reported,
 * dashed = inferred. Always paired with text for screen readers and on hover.
 */
export function ProvenanceMark({ p, showLabel = false }: { p: Provenance; showLabel?: boolean }) {
  const t = PROVENANCE_TEXT[p];
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-ink-3" title={`${t.label}: ${t.help}`}>
      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden className="shrink-0">
        {p === 'VERIFIED' && <circle cx="5" cy="5" r="4" fill="var(--signal)" />}
        {p === 'POLLED' && <circle cx="5" cy="5" r="3.4" fill="none" stroke="var(--signal)" strokeWidth="1.4" />}
        {p === 'SELF_REPORTED' && (
          <>
            <circle cx="5" cy="5" r="3.4" fill="none" stroke="var(--wait)" strokeWidth="1.4" />
            <circle cx="5" cy="5" r="1.4" fill="var(--wait)" />
          </>
        )}
        {p === 'INFERRED' && (
          <circle cx="5" cy="5" r="3.4" fill="none" stroke="var(--ink-3)" strokeWidth="1.4" strokeDasharray="2 1.6" />
        )}
      </svg>
      <span className={showLabel ? '' : 'sr-only'}>{t.label}</span>
    </span>
  );
}

export function Panel({
  title,
  aside,
  children,
  className,
}: {
  title?: React.ReactNode;
  aside?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={clsx('rounded-lg border border-line bg-panel', className)}>
      {title && (
        <header className="flex items-baseline justify-between gap-3 border-b border-line px-4 py-3">
          <h2 className="text-[15px] font-semibold">{title}</h2>
          {aside && <div className="text-sm text-ink-3">{aside}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-4 py-6 text-sm text-ink-3">{children}</p>;
}

export function Loading({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-2 p-4" aria-busy>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="h-5 animate-pulse rounded bg-sunken" style={{ width: `${85 - i * 15}%` }} />
      ))}
    </div>
  );
}

export function ErrorNote({ error }: { error: unknown }) {
  const status = (error as any)?.status;
  const msg =
    status === 403
      ? 'You don’t have access to this view. Individual metrics are visible to the person, their team lead and admins.'
      : `Couldn’t load this: ${(error as Error)?.message ?? 'unknown error'}. It will retry on its own.`;
  return <p className="px-4 py-4 text-sm text-fail">{msg}</p>;
}

export function Button({
  variant = 'default',
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'default' | 'primary' | 'quiet' }) {
  return (
    <button
      {...props}
      className={clsx(
        'inline-flex h-9 items-center justify-center gap-2 rounded-md px-3 text-sm font-medium transition-colors disabled:opacity-50',
        variant === 'primary' && 'bg-ink text-panel hover:opacity-90',
        variant === 'default' && 'border border-line bg-panel text-ink hover:bg-sunken',
        variant === 'quiet' && 'text-ink-2 hover:bg-sunken hover:text-ink',
        className,
      )}
    />
  );
}

export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-md border border-line bg-panel p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          role="radio"
          aria-checked={o.value === value}
          onClick={() => onChange(o.value)}
          className={clsx(
            'rounded px-2.5 py-1 text-sm',
            o.value === value ? 'bg-sunken font-medium text-ink' : 'text-ink-2 hover:text-ink',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function CiBadge({ state }: { state: PullRequestDTO['ciState'] }) {
  if (state === 'NONE') return null;
  const map = {
    SUCCESS: { text: 'Checks pass', cls: 'text-ok', icon: '✓' },
    FAILURE: { text: 'Checks fail', cls: 'text-fail', icon: '✕' },
    PENDING: { text: 'Checks running', cls: 'text-ink-3', icon: '◌' },
  } as const;
  const m = map[state];
  return (
    <span className={clsx('inline-flex items-center gap-1 text-xs', m.cls)}>
      <span aria-hidden>{m.icon}</span>
      {m.text}
    </span>
  );
}

export function PrRef({ pr }: { pr: Pick<PullRequestDTO, 'repo' | 'number' | 'url'> }) {
  return (
    <a href={pr.url} target="_blank" rel="noreferrer" className="font-mono text-xs text-ink-3 hover:text-ink hover:underline">
      {pr.repo}#{pr.number}
    </a>
  );
}

export const quietHours = (pr: PullRequestDTO) => (Date.now() - new Date(pr.lastActivityAt).getTime()) / 3_600_000;

/** One pull request in a queue. The bar shows how long it has waited relative to the queue's longest wait. */
export function PrRow({
  pr,
  maxWait,
  meta,
  measure = 'waiting',
}: {
  pr: PullRequestDTO;
  maxWait?: number;
  meta?: React.ReactNode;
  /** waiting = since ready, with no review; quiet = since the last activity of any kind */
  measure?: 'waiting' | 'quiet';
}) {
  const wait = measure === 'quiet' ? quietHours(pr) : pr.waitingHours;
  const width = wait !== null && maxWait ? Math.max(3, (wait / maxWait) * 100) : 0;
  const long = wait !== null && wait >= 24;
  return (
    <li className="grid grid-cols-[28px_1fr_auto] items-start gap-x-3 px-4 py-3">
      <Avatar name={pr.author.name} url={pr.author.avatarUrl} />
      <div className="min-w-0">
        <a href={pr.url} target="_blank" rel="noreferrer" className="block truncate font-medium hover:underline">
          {pr.title}
        </a>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-ink-3">
          <PrRef pr={pr} />
          <span>{pr.author.name}</span>
          <CiBadge state={pr.ciState} />
          {pr.requestedReviewers.length > 0 && <span>Waiting on {pr.requestedReviewers.join(', ')}</span>}
          {meta}
        </div>
        {width > 0 && (
          <div className="mt-2 h-1 rounded-full bg-sunken" aria-hidden>
            <div className={clsx('h-1 rounded-full', long ? 'bg-wait' : 'bg-ink-3/60')} style={{ width: `${width}%` }} />
          </div>
        )}
      </div>
      {wait !== null ? (
        <div className={clsx('text-right text-sm', long ? 'font-medium text-wait' : 'text-ink-2')}>
          {hours(wait)}
          <div className="text-xs font-normal text-ink-3">{measure === 'quiet' ? 'quiet' : 'waiting'}</div>
        </div>
      ) : (
        <span className="text-xs text-ink-3">{pr.size} lines</span>
      )}
    </li>
  );
}
