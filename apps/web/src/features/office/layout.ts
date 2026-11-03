/**
 * Pure floor-plan layout: team rooms with one desk per person, plus shared "commons" spots that
 * activities send people to. World units are pixels at scale 1; the canvas scales the world to fit.
 */
export type Activity =
  | 'CODING'
  | 'REVIEWING'
  | 'MERGING'
  | 'FIXING_CI'
  | 'RELEASING'
  | 'TRIAGING'
  | 'CELEBRATING'
  | 'BLOCKED'
  | 'NONE';

export type Point = { x: number; y: number };
export type Rect = { x: number; y: number; w: number; h: number };

export type SpotKind = 'review' | 'ci' | 'ship' | 'triage';

export type Room = { team: string; colorIndex: number; rect: Rect; desks: Record<string, Point> };
export type Commons = { kind: SpotKind; label: string; rect: Rect; prop: Point; slots: Point[] };

export type OfficeLayout = { width: number; height: number; rooms: Room[]; commons: Commons[] };

/** Where an activity sends someone. Desk activities stay home; the rest go to a shared spot. */
export const DESTINATION: Record<Activity, 'desk' | SpotKind> = {
  CODING: 'desk',
  BLOCKED: 'desk',
  NONE: 'desk',
  REVIEWING: 'review',
  MERGING: 'ship',
  RELEASING: 'ship',
  CELEBRATING: 'ship',
  FIXING_CI: 'ci',
  TRIAGING: 'triage',
};

const PAD = 24;
const GAP = 20;
const DESK_W = 96;
const DESK_H = 96;
const ROOM_HEADER = 44;

export function buildLayout(people: { id: string; team: string | null }[], wide: boolean): OfficeLayout {
  const width = wide ? 1240 : 560;
  const roomCols = wide ? 3 : 1;
  const teams = [...new Set(people.map((p) => p.team ?? 'No team'))].sort((a, b) =>
    a === 'No team' ? 1 : b === 'No team' ? -1 : a.localeCompare(b),
  );

  // Rooms flow into rows. A team too big for a third-width room gets a full-width one.
  const inner = width - PAD * 2;
  const smallW = (inner - GAP * (roomCols - 1)) / roomCols;
  const fitsSmall = (n: number) => Math.ceil(n / Math.max(2, Math.floor((smallW - 24) / DESK_W))) <= 3;
  const sizes = new Map(teams.map((t) => [t, people.filter((p) => (p.team ?? 'No team') === t).length]));
  const rowsOfTeams: string[][] = [];
  let pending: string[] = [];
  // Small rooms pack together first; big teams follow on full-width rows.
  const ordered = [...teams.filter((t) => fitsSmall(sizes.get(t)!)), ...teams.filter((t) => !fitsSmall(sizes.get(t)!))];
  for (const t of ordered) {
    if (!fitsSmall(sizes.get(t)!) && roomCols > 1) {
      if (pending.length) rowsOfTeams.push(pending);
      pending = [];
      rowsOfTeams.push([t]);
    } else {
      pending.push(t);
      if (pending.length === roomCols) {
        rowsOfTeams.push(pending);
        pending = [];
      }
    }
  }
  if (pending.length) rowsOfTeams.push(pending);

  const rooms: Room[] = [];
  let rowY = PAD;
  for (const rowTeams of rowsOfTeams) {
    const roomW = rowTeams.length === 1 && !fitsSmall(sizes.get(rowTeams[0])!) ? inner : smallW;
    const deskCols = Math.max(2, Math.floor((roomW - 24) / DESK_W));
    const rowH = Math.max(...rowTeams.map((t) => ROOM_HEADER + Math.ceil(sizes.get(t)! / deskCols) * DESK_H + 12));
    rowTeams.forEach((team, j) => {
      const rect = { x: PAD + j * (roomW + GAP), y: rowY, w: roomW, h: rowH };
      const members = people.filter((p) => (p.team ?? 'No team') === team).map((p) => p.id);
      const used = Math.min(deskCols, members.length) * DESK_W;
      const x0 = rect.x + (rect.w - used) / 2 + DESK_W / 2;
      const desks: Record<string, Point> = {};
      members.forEach((id, k) => {
        desks[id] = { x: x0 + (k % deskCols) * DESK_W, y: rect.y + ROOM_HEADER + Math.floor(k / deskCols) * DESK_H + 66 };
      });
      rooms.push({ team, colorIndex: teamColorIndex(team), rect, desks });
    });
    rowY += rowH + GAP;
  }

  // Commons: the shared spaces activities send people to.
  const commonsY = rowY + 8;
  const specs: { kind: SpotKind; label: string }[] = [
    { kind: 'ci', label: 'CI monitors' },
    { kind: 'review', label: 'Review table' },
    { kind: 'triage', label: 'Triage board' },
    { kind: 'ship', label: 'Ship bell' },
  ];
  const commons: Commons[] = [];
  const cols = wide ? 4 : 2;
  const cw = (width - PAD * 2 - GAP * (cols - 1)) / cols;
  // Room for an eighth of the company at any one spot (at least 9); beyond that people stand closer together.
  const capacity = Math.max(9, Math.ceil(people.length / 8));
  const perRow = Math.max(3, Math.floor((cw - 30) / SLOT_W));
  const queueRows = Math.ceil(capacity / perRow);
  const ch = 180 + queueRows * SLOT_H;
  specs.forEach((s, i) => {
    const rect = { x: PAD + (i % cols) * (cw + GAP), y: commonsY + Math.floor(i / cols) * (ch + GAP), w: cw, h: ch };
    const prop = { x: rect.x + rect.w / 2, y: rect.y + 78 };
    commons.push({ ...s, rect, prop, slots: slotsFor(s.kind, rect, prop, perRow, queueRows) });
  });
  const height = commonsY + Math.ceil(specs.length / cols) * (ch + GAP) + PAD - GAP + 8;
  return { width, height, rooms, commons };
}

const SLOT_W = 40;
const SLOT_H = 56;

/** Positions at each shared prop: seats around the review table first, then rows in front of the prop. */
function slotsFor(kind: SpotKind, rect: Rect, prop: Point, perRow: number, rows: number): Point[] {
  const slots: Point[] = [];
  if (kind === 'review') {
    // seats on the sides and the near side of the table, clear of the label above it
    for (const deg of [0, 180, 35, 145, 90]) {
      const a = (deg * Math.PI) / 180;
      slots.push({ x: prop.x + Math.cos(a) * 92, y: prop.y + 30 + Math.sin(a) * 46 });
    }
  }
  const top = prop.y + (kind === 'review' ? 136 : 90);
  const span = (perRow - 1) * SLOT_W;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < perRow; c++) {
      slots.push({ x: rect.x + rect.w / 2 - span / 2 + c * SLOT_W + (r % 2 ? SLOT_W / 2 : 0) * (c < perRow - 1 ? 1 : 0), y: top + r * SLOT_H });
    }
  }
  return slots;
}

/**
 * A team keeps its color when other teams are added or renamed: the slot comes from the name,
 * not from its position in a list. Rooms are always labeled, so a shared color never hides identity.
 * -1 means "No team", drawn in neutral ink.
 */
export function teamColorIndex(team: string): number {
  if (team === 'No team') return -1;
  let h = 0;
  for (const ch of team) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % 8;
}
