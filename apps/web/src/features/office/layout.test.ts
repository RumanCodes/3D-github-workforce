import { describe, expect, it } from 'vitest';
import { buildLayout, DESTINATION, teamColorIndex } from './layout';

const people = (teams: [string | null, number][]) =>
  teams.flatMap(([team, n]) => Array.from({ length: n }, (_, i) => ({ id: `${team ?? 'none'}-${i}`, team })));

const inside = (p: { x: number; y: number }, r: { x: number; y: number; w: number; h: number }) =>
  p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;

describe('office layout', () => {
  for (const wide of [true, false]) {
    it(`gives everyone exactly one desk inside their team's room (${wide ? 'wide' : 'narrow'})`, () => {
      const ppl = people([['Platform', 4], ['Web', 3], ['Support', 2], [null, 1], ['Payments', 30]]);
      const L = buildLayout(ppl, wide);
      for (const p of ppl) {
        const rooms = L.rooms.filter((r) => r.desks[p.id]);
        expect(rooms).toHaveLength(1);
        expect(rooms[0].team).toBe(p.team ?? 'No team');
        expect(inside(rooms[0].desks[p.id], rooms[0].rect)).toBe(true);
      }
      const desks = L.rooms.flatMap((r) => Object.values(r.desks));
      const keys = new Set(desks.map((d) => `${Math.round(d.x)}:${Math.round(d.y)}`));
      expect(keys.size).toBe(desks.length); // no two people share a desk
    });

    it(`keeps rooms and spots on the floor without overlap (${wide ? 'wide' : 'narrow'})`, () => {
      const L = buildLayout(people([['A', 3], ['B', 12], ['C', 2], ['D', 40]]), wide);
      const rects = [...L.rooms.map((r) => r.rect), ...L.commons.map((c) => c.rect)];
      for (const r of rects) {
        expect(r.x).toBeGreaterThanOrEqual(0);
        expect(r.x + r.w).toBeLessThanOrEqual(L.width + 0.01);
        expect(r.y + r.h).toBeLessThanOrEqual(L.height);
      }
      for (let i = 0; i < rects.length; i++)
        for (let j = i + 1; j < rects.length; j++) {
          const a = rects[i];
          const b = rects[j];
          const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
          expect(overlap).toBe(false);
        }
      for (const c of L.commons) for (const s of c.slots) expect(inside(s, c.rect)).toBe(true);
    });
  }

  it('gives big teams a full-width room and packs small rooms first', () => {
    const L = buildLayout(people([['Big', 40], ['Small', 2], ['Tiny', 1]]), true);
    const big = L.rooms.find((r) => r.team === 'Big')!;
    const small = L.rooms.find((r) => r.team === 'Small')!;
    expect(big.rect.w).toBeGreaterThan(small.rect.w * 2);
    expect(small.rect.y).toBeLessThan(big.rect.y);
  });

  it('has room at shared spots for a larger share of a bigger company', () => {
    const small = buildLayout(people([['A', 10]]), true).commons[0].slots.length;
    const large = buildLayout(people([['A', 50], ['B', 50], ['C', 50]]), true).commons[0].slots.length;
    expect(small).toBeGreaterThanOrEqual(9);
    expect(large).toBeGreaterThan(small);
  });

  it('keeps a team’s color when other teams change', () => {
    expect(teamColorIndex('Platform')).toBe(teamColorIndex('Platform'));
    expect(teamColorIndex('No team')).toBe(-1);
    for (const t of ['Platform', 'Web', 'Support', 'Design', 'Motion']) {
      expect(teamColorIndex(t)).toBeGreaterThanOrEqual(0);
      expect(teamColorIndex(t)).toBeLessThan(8);
    }
  });

  it('sends people somewhere only for real activity; no activity means their own desk', () => {
    expect(DESTINATION.NONE).toBe('desk');
    expect(DESTINATION.BLOCKED).toBe('desk');
    expect(DESTINATION.REVIEWING).toBe('review');
    expect(DESTINATION.FIXING_CI).toBe('ci');
    expect(DESTINATION.MERGING).toBe('ship');
  });
});
