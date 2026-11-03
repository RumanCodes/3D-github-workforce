export type { OfficeLayout } from '@workforce/contracts';
export function deskPosition(seat: number): [number, number, number] {
  const n = Math.max(0, seat - 1);
  return [(n % 10) * 3.4 - 15.3, 0, Math.floor(n / 10) * 3.8 - 10];
}
export const activityLabels: Record<string, string> = { CODING: 'Recently pushed or updated a PR', REVIEWING: 'Recently submitted a review', MERGING: 'Recently merged a PR', RELEASING: 'Recently published a release', FIXING_CI: 'A workflow failed', TRIAGING: 'Recently updated an issue', BLOCKED: 'Reported blocked', NONE: 'No recent tracked activity', CELEBRATING: 'Recently shipped' };
