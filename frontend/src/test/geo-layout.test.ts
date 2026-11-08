// Beehive geographic layout: compressed spacing, real shapes, honeycomb, routes, cards, overview.
import { describe, expect, it } from 'vitest';
import { mapModel } from '@/lib/live/derive';
import { event, facility, liveData, system } from './live-fixtures';

/** a test-network-like shape: 6 systems (S6..S11) far apart, 3 facilities each near their yard */
function network() {
  const systems = ['S6', 'S7', 'S8', 'S9', 'S10', 'S11'].map((id, i) =>
    system(id, 31 + (i % 3) * 0.6, -103 + Math.floor(i / 3) * 1.2, { disposalLat: 31 + (i % 3) * 0.6 + 0.02, disposalLon: -103 + Math.floor(i / 3) * 1.2 + 0.02 }),
  );
  const facilities = systems.flatMap((s: { systemId: string; yardLat: number; yardLon: number }) =>
    ['A', 'B', 'C'].map((l, j) => facility(`${s.systemId}_FACILITY_${l}`, s.systemId, { lat: s.yardLat + 0.05 + j * 0.03, lon: s.yardLon + 0.04 - j * 0.03 })),
  );
  return { systems, facilities };
}

describe('beehive geographic layout', () => {
  const { systems, facilities } = network();
  const live = liveData({ systems, facilities, events: [event('f', 'S8_FACILITY_A', 'S8', 'pump_failure')] });
  const m = mapModel(live);
  const g = m.geo;
  const at = (id: string) => g.nodes.find((n) => n.id === id)!;

  it('keeps every node inside the canvas', () => {
    for (const n of g.nodes) {
      expect(n.x).toBeGreaterThanOrEqual(0);
      expect(n.x).toBeLessThanOrEqual(m.W);
      expect(n.y).toBeGreaterThanOrEqual(0);
      expect(n.y).toBeLessThanOrEqual(m.H);
    }
  });

  it('compresses the space between systems but keeps each system’s real shape', () => {
    expect(g.compression).toBeLessThan(1);
    // within a system, distances keep their real proportions (A-B vs A-C, same scale)
    const d = (a: string, b: string) => Math.hypot(at(a).x - at(b).x, at(a).y - at(b).y);
    expect(d('S6_FACILITY_A', 'S6_FACILITY_C') / d('S6_FACILITY_A', 'S6_FACILITY_B')).toBeCloseTo(2, 1);
    // and every system is the same size as every other (same local scale)
    expect(d('S9_FACILITY_A', 'S9_FACILITY_B')).toBeCloseTo(d('S6_FACILITY_A', 'S6_FACILITY_B'), 3);
  });

  it('draws a truck route from each yard to each of its facilities', () => {
    expect(g.routes).toHaveLength(facilities.length);
    const r = g.routes.find((x) => x.facilityId === 'S7_FACILITY_B')!;
    expect(r.from).toEqual({ x: at('S7_TRUCK_YARD').x, y: at('S7_TRUCK_YARD').y });
    expect(r.to).toEqual({ x: at('S7_FACILITY_B').x, y: at('S7_FACILITY_B').y });
  });

  it('honeycomb: cells near a system belong to it; a failing system’s cells are flagged', () => {
    const owned = new Set(g.hexes.filter((h) => h.system).map((h) => h.system));
    expect([...owned].sort()).toEqual(['S10', 'S11', 'S6', 'S7', 'S8', 'S9']);
    expect(g.hexes.filter((h) => h.system === 'S8').every((h) => h.failing)).toBe(true);
    expect(g.hexes.filter((h) => h.system === 'S6').some((h) => h.failing)).toBe(false);
    expect(g.hexes.some((h) => h.system === null)).toBe(true); // background honeycomb
  });

  it('one card per system, no two cards overlapping', () => {
    expect(g.cards.map((c) => c.system).sort()).toEqual(['S10', 'S11', 'S6', 'S7', 'S8', 'S9']);
    for (let i = 0; i < g.cards.length; i++)
      for (let j = i + 1; j < g.cards.length; j++) {
        const a = g.cards[i]!;
        const b = g.cards[j]!;
        const overlap = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
        expect(overlap).toBe(0);
      }
  });

  it('the true-scale overview has every node and a label per system', () => {
    expect(g.overview.dots).toHaveLength(g.nodes.length);
    expect(g.overview.labels).toHaveLength(6);
  });
});
