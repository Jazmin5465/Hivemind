import network from '@/data/network.json';
import { detectedEvents, type Fleet } from './hive-data';

export interface FleetLoad { id: string; trucks: number; standby: number; failures: number; }
export interface Recommendation { kind: 'temporary' | 'long_term'; from: string; to: string; km: number; reason: string; }

const yard = (id: string) => network.systems.find(s => s.id === id)?.truck_yard as [number, number] | undefined;
export function yardKm(a: string, b: string) {
  const p = yard(a), q = yard(b);
  if (!p || !q) return Infinity;
  const r = Math.PI / 180, dLat = (q[0] - p[0]) * r, dLon = (q[1] - p[1]) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(p[0] * r) * Math.cos(q[0] * r) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}

/** Pump failures recorded per system — the events that need emergency hauling. */
export function failureCounts(events = detectedEvents) {
  const out: Record<string, number> = {};
  for (const e of events) if (e.category === 'pump_failure') out[e.facility.slice(0, 2)] = (out[e.facility.slice(0, 2)] ?? 0) + 1;
  return out;
}

export function recommendFleets(loads: FleetLoad[]): Recommendation[] {
  const recs: Recommendation[] = [];
  // Temporary: a fleet with every truck out borrows from the nearest fleet that can spare one (keeps ≥1 at home).
  for (const short of loads.filter(l => l.trucks > 0 && l.standby === 0)) {
    const donor = loads.filter(l => l.id !== short.id && l.standby >= 2).sort((a, b) => yardKm(short.id, a.id) - yardKm(short.id, b.id))[0];
    if (donor) recs.push({ kind: 'temporary', from: donor.id, to: short.id, km: yardKm(short.id, donor.id),
      reason: `All ${short.trucks} ${short.id} trucks are dispatched; ${donor.id} has ${donor.standby} on standby and is the closest yard.` });
  }
  // Long term: move a truck from the lightest-loaded fleet to the busiest when failures per truck differ by ≥2×.
  const ratio = (l: FleetLoad, delta = 0) => l.failures / Math.max(1, l.trucks + delta);
  const ranked = loads.filter(l => l.trucks > 0).sort((a, b) => ratio(b) - ratio(a));
  const busiest = ranked[0];
  const donor = [...ranked].reverse().find(l => l.id !== busiest?.id && l.trucks > 1);
  if (busiest && donor && busiest.failures > 0 && ratio(busiest) >= 2 * ratio(donor) && ratio(busiest, 1) >= ratio(donor, -1)) {
    recs.push({ kind: 'long_term', from: donor.id, to: busiest.id, km: yardKm(busiest.id, donor.id),
      reason: `${busiest.id} logged ${busiest.failures} pump failures for ${busiest.trucks} trucks (${ratio(busiest).toFixed(1)} per truck) vs ${donor.id} at ${ratio(donor).toFixed(1)}.` });
  }
  return recs;
}

export const fleetLoad = (f: Fleet, standby: number, counts = failureCounts()): FleetLoad => ({ id: f.id, trucks: f.trucks, standby, failures: counts[f.id] ?? 0 });
