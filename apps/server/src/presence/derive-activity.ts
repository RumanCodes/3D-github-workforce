import type { Activity, Provenance } from '@workforce/contracts';

/**
 * Maps a stored event to a short-lived *inferred* activity for the person who caused it.
 * The event itself stays VERIFIED; "is reviewing right now" is an inference and is labeled INFERRED.
 * Silence never produces a state: no rule here fires on the absence of events.
 */
type Rule = { activity: Activity; ttlMin: number; when?: (data: Record<string, any>) => boolean };

const RULES: Record<string, Rule> = {
  'pr.opened': { activity: 'CODING', ttlMin: 30 },
  'pr.synchronized': { activity: 'CODING', ttlMin: 30 },
  'pr.ready': { activity: 'CODING', ttlMin: 20 },
  'code.pushed': { activity: 'CODING', ttlMin: 30, when: (d) => !d.isDefault },
  'review.submitted': { activity: 'REVIEWING', ttlMin: 20 },
  'review.commented': { activity: 'REVIEWING', ttlMin: 15 },
  'pr.merged': { activity: 'MERGING', ttlMin: 5 },
  'ci.completed': { activity: 'FIXING_CI', ttlMin: 20, when: (d) => d.conclusion === 'failure' },
  'release.published': { activity: 'RELEASING', ttlMin: 15 },
  'issue.opened': { activity: 'TRIAGING', ttlMin: 15 },
  'issue.closed': { activity: 'TRIAGING', ttlMin: 10 },
  'status.blocked': { activity: 'BLOCKED', ttlMin: 240 },
  'status.cleared': { activity: 'NONE', ttlMin: 1 },
};

export type DerivedActivity = {
  activity: Activity;
  provenance: Provenance;
  expiresAt: Date;
};

export function deriveActivity(
  ev: { verb: string; provenance: Provenance; occurredAt: Date; data: Record<string, any> },
  now: Date,
  livePoll = false,
): DerivedActivity | null {
  if (ev.provenance === 'POLLED' && !livePoll) return null; // history must never animate
  const rule = RULES[ev.verb];
  if (!rule) return null;
  if (rule.when && !rule.when(ev.data ?? {})) return null;
  const expiresAt = new Date(ev.occurredAt.getTime() + rule.ttlMin * 60_000);
  if (expiresAt <= now) return null; // backfilled history never animates
  return {
    activity: rule.activity,
    provenance: ev.provenance === 'SELF_REPORTED' ? 'SELF_REPORTED' : 'INFERRED',
    expiresAt,
  };
}

export const ACTIVITY_LABEL: Record<Activity, string> = {
  CODING: 'Coding',
  REVIEWING: 'Reviewing',
  MERGING: 'Merging',
  FIXING_CI: 'CI failed',
  RELEASING: 'Releasing',
  TRIAGING: 'Triaging',
  CELEBRATING: 'Shipped',
  BLOCKED: 'Blocked',
  NONE: 'No recent tracked activity',
};
