import type { AgentStateDTO, OfficeLayout } from '@workforce/contracts';
export type Point = [number, number, number];
export type Zone = { name: string; center: Point; width: number; depth: number; color: string };
const COLORS = ['#4d827c', '#93694e', '#596f99', '#887296', '#7c864b', '#527f95'];
/** Stable seats within each team, independent of filtering and incoming events. */
export function officeSpatial(agents: AgentStateDTO[], layout: OfficeLayout) {
  const teams = [...new Set(agents.map((a) => a.team ?? 'Unassigned'))].sort();
  const seats = new Map(layout.desks.map((d) => [d.employeeId, d.seat]));
  const assignments = new Map(layout.desks.map((d) => [d.employeeId, d]));
  const positions = new Map<string, Point>();
  const zones: Zone[] = [];
  const maxMembers = Math.max(
    1,
    ...layout.desks.map((d) => (d.slot ?? 0) + 1),
    ...teams.map((t) => agents.filter((a) => (a.team ?? 'Unassigned') === t).length),
  );
  const zoneDepth = Math.max(13, Math.ceil(maxMembers / 4) * 3.4 + 5);
  teams.forEach((name, index) => {
    const zoneIndex = assignments.get(agents.find((a) => (a.team ?? 'Unassigned') === name)!.employeeId)?.zone ?? index;
    const x = (zoneIndex % 3) * 19 - 19,
      z = Math.floor(zoneIndex / 3) * (zoneDepth + 7);
    zones.push({ name, center: [x, 0, z], width: 16, depth: zoneDepth, color: COLORS[index % COLORS.length] });
    const members = agents
      .filter((a) => (a.team ?? 'Unassigned') === name)
      .sort(
        (a, b) =>
          (seats.get(a.employeeId) ?? 0) - (seats.get(b.employeeId) ?? 0) || a.employeeId.localeCompare(b.employeeId),
      );
    members.forEach((a, i) => {
      const slot = assignments.get(a.employeeId)?.slot ?? i;
      positions.set(a.employeeId, [x - 5.1 + (slot % 4) * 3.4, 0, z - zoneDepth / 2 + 3 + Math.floor(slot / 4) * 3.4]);
    });
  });
  const depth = Math.max(
    zoneDepth,
    Math.ceil(Math.max(teams.length, ...layout.desks.map((d) => (d.zone ?? 0) + 1)) / 3) * (zoneDepth + 7),
  );
  return {
    positions,
    zones,
    depth,
    review: [0, 0, -zoneDepth / 2 - 7] as Point,
    ci: [19, 0, -zoneDepth / 2 - 7] as Point,
    triage: [-19, 0, -zoneDepth / 2 - 7] as Point,
  };
}
export function activityDestination(
  activity: string,
  desk: Point,
  spots: { review: Point; ci: Point; triage: Point },
  index: number,
): Point {
  const base =
    activity === 'REVIEWING'
      ? spots.review
      : activity === 'FIXING_CI'
        ? spots.ci
        : activity === 'TRIAGING'
          ? spots.triage
          : null;
  return base
    ? [base[0] + ((index % 5) - 2) * 0.8, 0, base[2] + 1.7 + Math.floor(index / 5) * 0.7]
    : [desk[0], 0, desk[2] + 1];
}
