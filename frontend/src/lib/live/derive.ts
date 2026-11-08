// Pure functions: live SpacetimeDB snapshot -> what the pages render. No calculations of
// detection, countdowns or plan costs happen here; those come from the backend as-is.
// The only browser-side numbers are display conversions and the "proactive watch" what-if
// (time to shutdown if a healthy pump stopped now), which uses live readings.
import type { Decision, Event, Facility, FleetSweep, Plan, PlanFacility } from '@/module_bindings/types';
import type { LiveData } from './store';

export type Severity = 'critical' | 'high' | 'medium';
export type Category = 'pump_failure' | 'pump_degradation' | 'pipeline_leak' | 'tank_fill';

export interface PriorityItem {
  id: string;
  facility: string;
  asset: string;
  systemId: string;
  category: Category;
  title: string;
  detail: string;
  severity: Severity;
  seconds?: number | undefined;
  /** proactive watch item (hypothetical pump stop), not a live alert */
  scenario: boolean;
  onset: number;
  /** backend event id (live alerts only) */
  eventId?: string | undefined;
  confidence?: number | undefined;
  source?: string | undefined;
}

export const formatDuration = (s: number) => {
  const m = Math.round(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
};
export const formatTime = (ts: number) => new Date(ts * 1000).toISOString().slice(5, 16).replace('T', ' ') + ' UTC';
export const fmtCountdown = (seconds: number) => {
  const v = Math.max(0, Math.floor(seconds));
  return [Math.floor(v / 3600), Math.floor((v % 3600) / 60), v % 60].map((n) => String(n).padStart(2, '0')).join(':');
};

export const nowOf = (live: LiveData) => live.clock?.nowUnix ?? live.dataset?.tEnd ?? 0;
export const thresholdsOf = (live: LiveData) => ({ warning: live.opsConfig?.warningPct ?? 0, shutdown: live.opsConfig?.shutdownPct ?? 0 });

/** active (not revoked) decisions */
export const activeDecisions = (live: LiveData) => live.decisions.filter((d) => d.status === 'active');

export const ongoingEvents = (live: LiveData) => live.events.filter((e) => e.status === 'ongoing').sort((a, b) => (a.alertRank || 1e9) - (b.alertRank || 1e9));

const TITLE: Record<string, string> = { pipeline_leak: 'Pipeline leak', pump_degradation: 'Pump wear', pump_failure: 'Pump failure' };
const DETAIL: Record<string, string> = {
  pipeline_leak: 'Sustained flow imbalance · urgent inspection',
  pump_degradation: 'Reduced pump capacity · inspection required',
  pump_failure: 'Pump stopped · tank filling',
};

function alertItem(e: Event): PriorityItem {
  return {
    id: e.eventId,
    eventId: e.eventId,
    asset: e.assetId,
    facility: e.facilityId,
    systemId: e.systemId,
    category: e.category as Category,
    onset: e.onsetUnix,
    seconds: e.category === 'pump_failure' && e.hoursToLimitP50 != null ? e.hoursToLimitP50 * 3600 : undefined,
    scenario: false,
    severity: e.category === 'pump_degradation' ? 'high' : 'critical',
    title: TITLE[e.category] ?? e.category,
    detail: DETAIL[e.category] ?? '',
    confidence: e.confidence,
    source: e.source,
  };
}

/** seconds until a tank reaches shutdown if its pump stopped now (live level + live inflow) */
export function secondsToShutdownIfPumpStops(levelPct: number, capacityBbl: number, inflowBpd: number, shutdownPct: number) {
  if (!(inflowBpd > 0) || !(capacityBbl > 0) || !Number.isFinite(levelPct)) return Infinity;
  const ratePctPerHour = (inflowBpd / 24 / capacityBbl) * 100;
  return (Math.max(0, shutdownPct - levelPct) / ratePctPerHour) * 3600;
}

/** Proactive watch: the 3 healthy tanks that would shut in soonest if their pump stopped now. */
export function watchItems(live: LiveData, limit = 3): PriorityItem[] {
  const { shutdown } = thresholdsOf(live);
  const failing = new Set(live.events.filter((e) => e.status === 'ongoing' && e.category === 'pump_failure').map((e) => e.facilityId));
  const now = nowOf(live);
  return live.facilityStates
    .filter((s) => !failing.has(s.facilityId))
    .map((s): PriorityItem => {
      const f = live.facilities.find((x) => x.facilityId === s.facilityId);
      return {
        id: `watch:${s.facilityId}`,
        asset: f?.tankId ?? s.facilityId,
        facility: s.facilityId,
        systemId: s.systemId,
        category: 'tank_fill',
        onset: now,
        scenario: true,
        title: 'Tank fill exposure',
        severity: 'medium',
        seconds: secondsToShutdownIfPumpStops(s.levelPct, f?.capacityBbl ?? 0, s.inflowBpd, shutdown),
        detail: 'If the pump stops · constant inflow scenario',
      };
    })
    .filter((i) => Number.isFinite(i.seconds))
    .sort((a, b) => (a.seconds ?? Infinity) - (b.seconds ?? Infinity))
    .slice(0, limit);
}

/** Live alerts in the backend's SPEC order (alertRank), then proactive watch items. */
export function priorityQueue(live: LiveData): PriorityItem[] {
  return [...ongoingEvents(live).map(alertItem), ...watchItems(live)];
}

/** items without an active decision (alerts by event, watch items by facility contingency) */
export function pendingPriority(items: PriorityItem[], decisions: Decision[]): PriorityItem[] {
  const active = decisions.filter((d) => d.status === 'active');
  return items.filter((i) =>
    i.scenario
      ? !active.some((d) => d.kind === 'contingency' && d.facilityId === i.facility)
      : !active.some((d) => d.eventId === i.eventId),
  );
}

// ---------- plan options for the decision popup ----------
export type PlanKey = 'optimal' | 'shut_in_only' | 'trucks_only' | 'do_nothing' | 'inspect';
export interface DecisionPlan {
  key: PlanKey;
  label: string;
  planId?: bigint | undefined;
  /** total for the whole joint plan (all failures it covers) */
  cost: number;
  truckingCost: number;
  revenueLoss: number;
  trips: number;
  trucks: number;
  wellIds: string[];
  /** hours from now until an automatic shut-in under this plan (earliest facility), null = none */
  shutdownHours: number | null;
  /** per-facility plan text from the planner */
  lines: { facilityId: string; summary: string }[];
  valid: boolean;
  errors: string[];
}

/** Jazmin's option names, chosen from what the plan actually does */
function contentLabel(trucks: number, shutIn: boolean) {
  if (trucks > 0 && shutIn) return 'Wells + trucks';
  if (trucks > 0) return 'Send trucks';
  if (shutIn) return 'Shut in selected wells';
  return 'Do nothing';
}
const OPTION_ORDER = ['optimal', 'shut_in_only', 'trucks_only', 'do_nothing'];

export function planToOption(live: LiveData, p: Plan): DecisionPlan {
  const facs = live.planFacilities.filter((f) => f.planId === p.planId);
  const acts = live.planActions.filter((a) => a.planId === p.planId);
  const trips = acts.filter((a) => a.type === 'dispatch_truck').reduce((s, a) => s + a.trucks * a.tripsPerTruck, 0);
  const trucks = acts.filter((a) => a.type === 'dispatch_truck').reduce((s, a) => s + a.trucks, 0);
  const trips_ = facs.map((f) => f.tripsAtUnix).filter((t): t is number => t != null);
  return {
    key: (p.optionKey || 'optimal') as PlanKey,
    label: contentLabel(trucks, acts.some((a) => a.type === 'shut_in_wells')),
    planId: p.planId,
    cost: p.totalCost,
    truckingCost: facs.reduce((s, f) => s + f.truckCost, 0),
    revenueLoss: facs.reduce((s, f) => s + f.shutInCost + f.tripCost, 0),
    trips,
    trucks,
    wellIds: acts.filter((a) => a.type === 'shut_in_wells').flatMap((a) => a.wells),
    shutdownHours: trips_.length ? (Math.min(...trips_) - p.planStartUnix) / 3600 : null,
    lines: facs.map((f) => ({ facilityId: f.facilityId, summary: f.summary })),
    valid: p.valid,
    errors: p.validationErrors,
  };
}

/** The 4 options this operator requested for a system (newest batch), in a fixed order. */
export function optionPlans(live: LiveData, systemId: string, scenarioFacilityId: string): Plan[] {
  const mine = live.plans.filter(
    (p) => p.origin === 'option' && p.status === 'proposed' && p.systemId === systemId && p.scenarioFacilityId === scenarioFacilityId && p.createdBy.toHexString() === live.identity,
  );
  if (!mine.length) return [];
  const newest = mine.reduce((m, p) => (p.createdAt.microsSinceUnixEpoch > m ? p.createdAt.microsSinceUnixEpoch : m), mine[0]!.createdAt.microsSinceUnixEpoch);
  return mine.filter((p) => p.createdAt.microsSinceUnixEpoch === newest).sort((a, b) => OPTION_ORDER.indexOf(a.optionKey) - OPTION_ORDER.indexOf(b.optionKey));
}

export const inspectOption = (category: Category): DecisionPlan => ({
  key: 'inspect',
  label: 'Send inspector',
  cost: 0,
  truckingCost: 0,
  revenueLoss: 0,
  trips: 0,
  trucks: 0,
  wellIds: [],
  shutdownHours: null,
  lines: [{ facilityId: '', summary: category === 'pipeline_leak' ? 'Urgent leak inspection · pump continues moving water' : 'Inspect pump wear · no alternate disposal needed' }],
  valid: true,
  errors: [],
});

/** the alternatives that were offered alongside a chosen plan (same request batch) */
export function siblingOptions(live: LiveData, p: Plan): Plan[] {
  return live.plans.filter(
    (o) => o.origin === 'option' && o.systemId === p.systemId && o.scenarioFacilityId === p.scenarioFacilityId && o.createdAt.microsSinceUnixEpoch === p.createdAt.microsSinceUnixEpoch,
  );
}

// ---------- fleets ----------
export interface Fleet {
  id: string;
  name: string;
  trucks: number;
  base: string;
}
export function fleets(live: LiveData): Fleet[] {
  return live.systems.map((s) => ({
    id: s.systemId,
    name: `${s.systemId} Emergency Fleet`,
    trucks: live.opsSystems.find((o) => o.systemId === s.systemId)?.fleetSize ?? 0,
    base: `${live.facilities.filter((f) => f.systemId === s.systemId).length} facilities · yard ${s.yardLat}, ${s.yardLon}`,
  }));
}

export type TruckStatus = { unit: string; status: 'Standby' | 'En route' | 'Hauling'; facility?: string; eta?: number; back?: number; trips?: number };

/** Each truck's status from the APPROVED plans of the fleet's system (trucks dispatched at plan start). */
export function fleetTrucks(live: LiveData, fleet: Fleet): TruckStatus[] {
  const now = nowOf(live);
  const trucks: TruckStatus[] = Array.from({ length: fleet.trucks }, (_, i) => ({ unit: `TRK-${fleet.id}-${String.fromCharCode(65 + i)}`, status: 'Standby' }));
  let next = 0;
  const approved = live.plans.filter((p) => p.status === 'approved' && p.systemId === fleet.id && !p.scenarioFacilityId).sort((a, b) => a.planStartUnix - b.planStartUnix);
  for (const p of approved) {
    for (const a of live.planActions.filter((x) => x.planId === p.planId && x.type === 'dispatch_truck')) {
      const pf: PlanFacility | undefined = live.planFacilities.find((f) => f.planId === p.planId && f.facilityId === a.facilityId);
      const eta = pf?.truckArrivalsUnix[0] ?? p.planStartUnix;
      const back = pf?.truckFreeAtUnix[0] ?? eta;
      for (let k = 0; k < a.trucks && next < trucks.length; k++) {
        if (back <= now || p.planStartUnix > now) continue; // returned, or plan not started at this clock
        trucks[next] = { unit: `TRK-${fleet.id}-${String.fromCharCode(65 + next)}`, status: now < eta ? 'En route' : 'Hauling', facility: a.facilityId, eta, back, trips: a.tripsPerTruck };
        next++;
      }
    }
  }
  return trucks;
}

export interface FleetLoad {
  id: string;
  trucks: number;
  standby: number;
  failures: number;
}
export interface Recommendation {
  kind: 'temporary' | 'long_term';
  from: string;
  to: string;
  km: number;
  reason: string;
}

function yardKm(live: LiveData, a: string, b: string) {
  const p = live.systems.find((s) => s.systemId === a);
  const q = live.systems.find((s) => s.systemId === b);
  if (!p || !q) return Infinity;
  const r = Math.PI / 180;
  const dLat = (q.yardLat - p.yardLat) * r;
  const dLon = (q.yardLon - p.yardLon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(p.yardLat * r) * Math.cos(q.yardLat * r) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}

/** Right now: a fleet with every truck out borrows from the nearest fleet that keeps >= 1 on standby. */
export function temporaryRecommendations(live: LiveData, loads: FleetLoad[]): Recommendation[] {
  const recs: Recommendation[] = [];
  for (const short of loads.filter((l) => l.trucks > 0 && l.standby === 0)) {
    const donor = loads.filter((l) => l.id !== short.id && l.standby >= 2).sort((a, b) => yardKm(live, short.id, a.id) - yardKm(live, short.id, b.id))[0];
    if (donor)
      recs.push({
        kind: 'temporary',
        from: donor.id,
        to: short.id,
        km: yardKm(live, short.id, donor.id),
        reason: `All ${short.trucks} ${short.id} trucks are dispatched; ${donor.id} has ${donor.standby} on standby and is the closest yard.`,
      });
  }
  return recs;
}

const usd = (v: number) => `$${Math.round(v).toLocaleString('en-US')}`;

/**
 * Long term, from the backend's fleet sweep (the week's failures replayed per fleet size):
 * move one truck from the system that loses least with one fewer to the one that saves most
 * with one more, if the saving beats the loss.
 */
export function longTermRecommendation(live: LiveData, sweep: FleetSweep[] = live.fleetSweep): Recommendation | null {
  const bySys = new Map<string, FleetSweep[]>();
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
    from: from.id,
    to: to.id,
    km: yardKm(live, to.id, from.id),
    reason: `Replaying this dataset's ${to.cur?.failures ?? 0} ${to.id} pump failures: one more truck saves ${usd(to.gain)}; ${from.id} loses ${usd(from.loss)} with one fewer.`,
  };
}

export function failureCounts(live: LiveData) {
  const out: Record<string, number> = {};
  for (const e of live.events) if (e.category === 'pump_failure') out[e.systemId] = (out[e.systemId] ?? 0) + 1;
  return out;
}

// ---------- timeline ----------
export interface HistoryNode {
  id: string;
  ts: number;
  title: string;
  detail: string;
  kind: 'sensor' | 'recovery' | 'now' | 'forecast' | 'decision';
  category?: string;
  system?: string;
  parentId?: string;
  relation?: string;
  recordedAt?: string;
}

export function historyNodes(live: LiveData): HistoryNode[] {
  const now = nowOf(live);
  const nodes: HistoryNode[] = [];
  for (const e of live.events) {
    const ev = live.evidence.filter((x) => x.eventId === e.eventId).sort((a, b) => a.rank - b.rank)[0]?.text;
    const duration = e.endUnix == null ? ` · active ${formatDuration(now - e.onsetUnix)}` : '';
    nodes.push({
      id: e.eventId,
      ts: e.onsetUnix,
      title: `${e.assetId} · ${e.category.replaceAll('_', ' ')}`,
      detail: `${ev ?? e.facilityId}${duration} · confidence ${Math.round(e.confidence * 100)}%`,
      category: e.category,
      kind: 'sensor',
      system: e.systemId,
    });
    if (e.endUnix != null)
      nodes.push({
        id: `${e.eventId}:recovery`,
        ts: e.endUnix,
        title: `${e.assetId} · recovered`,
        detail: `Resolved in ${formatDuration(e.endUnix - e.onsetUnix)}`,
        category: 'recovery',
        kind: 'recovery',
        system: e.systemId,
        parentId: e.eventId,
        relation: `Recovery from previous incident at ${formatTime(e.onsetUnix)}`,
      });
  }
  return nodes;
}

export function forecastNodes(live: LiveData): HistoryNode[] {
  const now = nowOf(live);
  return watchItems(live).map((q) => {
    const s = live.facilityStates.find((x) => x.facilityId === q.facility);
    return {
      id: q.id,
      ts: now + (q.seconds ?? 0),
      title: `${q.facility} · tank fill exposure`,
      detail: `Tank ${(s?.levelPct ?? 0).toFixed(0)}% · inflow ${(s?.inflowBpd ?? 0).toFixed(0)} bpd · ${((q.seconds ?? 0) / 3600).toFixed(1)}h to shut-in limit`,
      kind: 'forecast' as const,
      category: 'tank_fill',
      system: q.systemId,
    };
  });
}

export function decisionNodes(live: LiveData): HistoryNode[] {
  return activeDecisions(live).map((d) => ({
    id: `decision:${d.id}`,
    ts: d.asOfUnix,
    recordedAt: new Date(Number(d.createdAt.microsSinceUnixEpoch / 1000n)).toISOString(),
    title: d.title,
    detail: `${d.detail} · by ${d.operatorName}${d.kind === 'inspection' ? '' : ` · Estimated ${usd(d.estimatedCost)}`}`,
    kind: 'decision' as const,
    system: d.systemId,
    parentId: d.kind === 'contingency' ? `watch:${d.facilityId}` : d.eventId,
    relation: d.kind === 'contingency' ? 'Contingency for this forecast' : 'Decision for this item',
  }));
}

export function sortHistory(nodes: HistoryNode[]) {
  return [...nodes].sort((a, b) => b.ts - a.ts || (b.recordedAt ?? '').localeCompare(a.recordedAt ?? '') || a.id.localeCompare(b.id));
}

// ---------- network map ----------
export type NodeKind = 'facility' | 'tank' | 'pump' | 'disposal' | 'well' | 'yard';
export interface MapNode {
  id: string;
  label: string;
  kind: NodeKind;
  x: number;
  y: number;
  status: 'ok' | 'warn' | 'fail';
  detail?: string;
  system: string;
}
export interface SystemBox {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  trucks: number;
  health: 'NORMAL' | 'CRITICAL';
}
export interface MapEdge {
  from: string;
  to: string;
  id: string;
  failing?: boolean;
  system: string;
}

const fmt = (v: number | undefined, d = 0) => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(d));

export interface MapModel {
  W: number;
  H: number;
  nodes: MapNode[];
  edges: MapEdge[];
  boxes: SystemBox[];
  geoNodes: MapNode[];
  geoEdges: MapEdge[];
  /** geographic axis ticks (lat/lon labels positioned in map coordinates) */
  latTicks: { value: number; y: number }[];
  lonTicks: { value: number; x: number }[];
}

/** Map layout. The canvas grows with the number of systems/facilities (any network shape). */
export function mapModel(live: LiveData): MapModel {
  const { warning, shutdown } = thresholdsOf(live);
  const ongoing = live.events.filter((e) => e.status === 'ongoing');
  const has = (facilityId: string, cat: string) => ongoing.some((e) => e.facilityId === facilityId && e.category === cat);
  const maxFac = Math.max(1, ...live.systems.map((s) => live.facilities.filter((f) => f.systemId === s.systemId).length));
  const W = Math.max(1080, 30 + live.systems.length * 210 + 10);
  const H = Math.max(960, 30 + 150 + maxFac * 180 + 30);
  const nodes: MapNode[] = [];
  const edges: MapEdge[] = [];
  const boxes: SystemBox[] = [];
  live.systems.forEach((system, si) => {
    const facs = live.facilities.filter((f) => f.systemId === system.systemId);
    const boxX = 30 + si * 210;
    const boxW = 190;
    const boxY = 30;
    const boxH = 150 + facs.length * 180;
    const cx = boxX + boxW / 2;
    const trucks = live.opsSystems.find((o) => o.systemId === system.systemId)?.fleetSize ?? 0;
    boxes.push({ id: system.systemId, x: boxX, y: boxY, w: boxW, h: boxH, trucks, health: facs.some((f) => has(f.facilityId, 'pump_failure')) ? 'CRITICAL' : 'NORMAL' });
    nodes.push({ id: system.disposalId, label: 'SWD', kind: 'disposal', x: cx, y: boxY + boxH - 55, status: 'ok', detail: `${system.disposalPressurePsi} psi normal · ${system.disposalLat}, ${system.disposalLon}`, system: system.systemId });
    facs.forEach((f: Facility, fi) => {
      const s = live.facilityStates.find((x) => x.facilityId === f.facilityId);
      const fy = boxY + 140 + fi * 180;
      const failed = has(f.facilityId, 'pump_failure');
      const worn = has(f.facilityId, 'pump_degradation');
      const leak = has(f.facilityId, 'pipeline_leak');
      const level = s?.levelPct ?? NaN;
      nodes.push({ id: f.facilityId, label: f.facilityId.startsWith(`${system.systemId}_`) ? f.facilityId.slice(system.systemId.length + 1) : f.facilityId, kind: 'facility', x: cx, y: fy, status: failed ? 'fail' : 'ok', detail: `${fmt(s?.inflowBpd)} bpd inflow · ${f.lat}, ${f.lon}`, system: system.systemId });
      nodes.push({ id: f.tankId, label: `${fmt(level, 1)}%`, kind: 'tank', x: cx - 48, y: fy + 78, status: level >= shutdown ? 'fail' : level >= warning ? 'warn' : 'ok', detail: `${fmt(level, 1)}% · ${f.capacityBbl} bbl capacity`, system: system.systemId });
      const pumpText = s?.pumpStatus === 2 ? 'Failed' : s?.pumpStatus === 0 ? 'Normal cycle stop' : 'Running';
      nodes.push({ id: f.pumpId, label: 'PUMP', kind: 'pump', x: cx + 48, y: fy + 78, status: failed ? 'fail' : worn ? 'warn' : 'ok', detail: `${fmt(s?.pumpFlowBpd)} bpd · ${fmt(s?.dischargePsi)} psi · ${pumpText}`, system: system.systemId });
      const wells = live.wells.filter((w) => w.facilityId === f.facilityId);
      wells.forEach((w, wi) => {
        const k = s?.wellIds.indexOf(w.wellId) ?? -1;
        const st = k >= 0 ? s?.wellStatus[k] : undefined;
        const water = k >= 0 ? s?.wellWaterBpd[k] : undefined;
        nodes.push({ id: w.wellId, label: w.wellId.split('_').at(-1) ?? w.wellId, kind: 'well', x: cx - 58 + wi * 58, y: fy - 62, status: st === 0 ? 'warn' : 'ok', detail: `${fmt(water)} water bpd · ${w.oilBpd} oil bpd · ${w.gasMcfd} gas mcfd`, system: system.systemId });
        edges.push({ id: w.wellId, from: w.wellId, to: f.facilityId, system: system.systemId });
      });
      edges.push(
        { id: `${f.facilityId}-tank`, from: f.facilityId, to: f.tankId, system: system.systemId },
        { id: `${f.facilityId}-pump`, from: f.tankId, to: f.pumpId, failing: failed, system: system.systemId },
        { id: f.pipelineId, from: f.pumpId, to: system.disposalId, failing: leak, system: system.systemId },
      );
    });
  });

  // Geographic view: equirectangular projection fitted to this network's own coordinates.
  const lats = [...live.facilities.map((f) => f.lat), ...live.systems.flatMap((s) => [s.disposalLat, s.yardLat])];
  const lons = [...live.facilities.map((f) => f.lon), ...live.systems.flatMap((s) => [s.disposalLon, s.yardLon])];
  const pad = 60;
  const latMin = lats.length ? Math.min(...lats) : 0;
  const latMax = lats.length ? Math.max(...lats) : 1;
  const lonMin = lons.length ? Math.min(...lons) : 0;
  const lonMax = lons.length ? Math.max(...lons) : 1;
  const kx = (W - 2 * pad) / Math.max(1e-6, lonMax - lonMin);
  const ky = (H - 2 * pad) / Math.max(1e-6, latMax - latMin);
  const k = Math.min(kx, ky);
  const gx = (lon: number) => pad + (lon - lonMin) * k;
  const gy = (lat: number) => pad + (latMax - lat) * k;
  const geoNodes: MapNode[] = [];
  const geoEdges: MapEdge[] = [];
  for (const system of live.systems) {
    const swd = nodes.find((n) => n.id === system.disposalId);
    if (swd) geoNodes.push({ ...swd, x: gx(system.disposalLon), y: gy(system.disposalLat) });
    const trucks = live.opsSystems.find((o) => o.systemId === system.systemId)?.fleetSize ?? 0;
    geoNodes.push({ id: `${system.systemId}_TRUCK_YARD`, label: `${system.systemId} YARD`, kind: 'yard', x: gx(system.yardLon), y: gy(system.yardLat), status: 'ok', detail: `${trucks} trucks · ${system.yardLat}, ${system.yardLon}`, system: system.systemId });
    for (const f of live.facilities.filter((x) => x.systemId === system.systemId)) {
      const fac = nodes.find((n) => n.id === f.facilityId);
      const pump = nodes.find((n) => n.id === f.pumpId);
      if (fac) geoNodes.push({ ...fac, x: gx(f.lon), y: gy(f.lat), status: pump && pump.status !== 'ok' ? pump.status : fac.status });
      const pipe = edges.find((e) => e.id === f.pipelineId);
      geoEdges.push({ id: f.pipelineId, from: f.facilityId, to: system.disposalId, failing: pipe?.failing ?? false, system: system.systemId });
    }
  }
  const ticks = (lo: number, hi: number) => {
    const span = hi - lo;
    const step = span > 2 ? 1 : span > 1 ? 0.5 : span > 0.4 ? 0.25 : 0.1;
    const out: number[] = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Math.round(v * 100) / 100);
    return out;
  };
  return {
    W,
    H,
    nodes,
    edges,
    boxes,
    geoNodes,
    geoEdges,
    latTicks: ticks(latMin, latMax).map((value) => ({ value, y: gy(value) })),
    lonTicks: ticks(lonMin, lonMax).map((value) => ({ value, x: gx(value) })),
  };
}

export const headerSummary = (live: LiveData) => ({ now: nowOf(live), alerts: ongoingEvents(live).length });
