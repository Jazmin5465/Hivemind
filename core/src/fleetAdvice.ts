// Proactive watch and fleet advice (moved from the frontend so the console only displays backend data).
//  - watch: healthy tanks that would reach shutdown soonest if their pump stopped now
//  - temporary: a system with every truck out borrows from the nearest system with >= 2 on standby
//  - long term: move one truck from the system that loses least with one fewer to the one that saves
//    most with one more, using the fleet sweep (the week's failures replayed per fleet size)
import type { DatasetModel } from './model';
import type { FleetSweepRow } from './fleetSweep';

export interface WatchInput {
  facilityId: string;
  levelPct: number;
  inflowBpd: number;
}

/** hours until shutdown if the pump stopped now, from the live level and live inflow; null = never */
export function hoursToShutdownIfPumpStops(levelPct: number, capacityBbl: number, inflowBpd: number, shutdownPct: number): number | null {
  if (!(inflowBpd > 0) || !(capacityBbl > 0) || !Number.isFinite(levelPct)) return null;
  const ratePctPerHour = (inflowBpd / 24 / capacityBbl) * 100;
  return Math.max(0, shutdownPct - levelPct) / ratePctPerHour;
}

/** the `limit` healthy facilities that would shut in soonest; failing pumps excluded */
export function watchList(model: DatasetModel, states: WatchInput[], failingFacilities: Set<string>, limit = 3) {
  return states
    .filter((s) => !failingFacilities.has(s.facilityId))
    .map((s) => {
      const f = model.facilityById.get(s.facilityId);
      return { facilityId: s.facilityId, hours: f ? hoursToShutdownIfPumpStops(s.levelPct, f.capacityBbl, s.inflowBpd, model.shutdownPct) : null };
    })
    .filter((w): w is { facilityId: string; hours: number } => w.hours != null)
    .sort((a, b) => a.hours - b.hours)
    .slice(0, limit);
}

export interface FleetAdvice {
  kind: 'temporary' | 'long_term';
  fromSystem: string;
  toSystem: string;
  km: number;
  reason: string;
  /** long term: $ saved by the receiving system with one more truck (0 for temporary) */
  savings: number;
}

export function yardKm(model: DatasetModel, a: string, b: string): number {
  const p = model.systemById.get(a);
  const q = model.systemById.get(b);
  if (!p || !q) return Infinity;
  const r = Math.PI / 180;
  const dLat = (q.yardLat - p.yardLat) * r;
  const dLon = (q.yardLon - p.yardLon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(p.yardLat * r) * Math.cos(q.yardLat * r) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}

/** right now: every truck out -> borrow 1 from the nearest system that keeps >= 1 on standby */
export function temporaryAdvice(model: DatasetModel, standby: Map<string, number>): FleetAdvice[] {
  const out: FleetAdvice[] = [];
  const loads = model.systems.map((s) => ({ id: s.id, trucks: s.fleetSize, standby: standby.get(s.id) ?? s.fleetSize }));
  for (const short of loads.filter((l) => l.trucks > 0 && l.standby === 0)) {
    const donor = loads.filter((l) => l.id !== short.id && l.standby >= 2).sort((a, b) => yardKm(model, short.id, a.id) - yardKm(model, short.id, b.id))[0];
    if (donor)
      out.push({
        kind: 'temporary',
        fromSystem: donor.id,
        toSystem: short.id,
        km: yardKm(model, short.id, donor.id),
        reason: `All ${short.trucks} ${short.id} trucks are dispatched; ${donor.id} has ${donor.standby} on standby and is the closest yard.`,
        savings: 0,
      });
  }
  return out;
}

const usd = (v: number) => `$${Math.round(v).toLocaleString('en-US')}`;

export function longTermAdvice(model: DatasetModel, sweep: FleetSweepRow[]): FleetAdvice | null {
  const bySys = new Map<string, FleetSweepRow[]>();
  for (const r of sweep) bySys.set(r.systemId, [...(bySys.get(r.systemId) ?? []), r]);
  const delta = [...bySys.entries()].map(([id, rows]) => {
    const cur = rows.find((r) => r.isCurrent);
    const cost = (n: number) => rows.find((r) => r.fleetSize === n)?.totalCost;
    const plus = cur ? cost(cur.fleetSize + 1) : undefined;
    const minus = cur && cur.fleetSize > 1 ? cost(cur.fleetSize - 1) : undefined;
    return { id, cur, gain: cur && plus != null ? cur.totalCost - plus : 0, loss: cur && minus != null ? minus - cur.totalCost : Infinity };
  });
  const to = [...delta].sort((a, b) => b.gain - a.gain)[0];
  const from = delta.filter((d) => d.id !== to?.id && Number.isFinite(d.loss)).sort((a, b) => a.loss - b.loss)[0];
  if (!to || !from || !(to.gain > 0) || !(to.gain > from.loss)) return null;
  return {
    kind: 'long_term',
    fromSystem: from.id,
    toSystem: to.id,
    km: yardKm(model, to.id, from.id),
    reason: `Replaying this dataset's ${to.cur?.failures ?? 0} ${to.id} pump failures: one more truck saves ${usd(to.gain)}; ${from.id} loses ${usd(from.loss)} with one fewer.`,
    savings: to.gain,
  };
}
