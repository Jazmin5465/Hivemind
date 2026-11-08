// Pure functions: live SpacetimeDB snapshot -> what the pages render. Detection, countdowns,
// proactive watch, plan options/costs and fleet advice all come from the backend as-is; this
// file only maps rows to display shapes (plus real-time ticking between backend updates).
import type { Decision, Event, Facility, Plan, PlanFacility } from '@/module_bindings/types';
import type { LiveData } from './store';
import { geoLayout, type GeoModel } from './geoLayout';

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

/**
 * The backend clock, advanced in real time since its last update (1 s per second) while the
 * clock is paused, so countdowns and truck progress move between backend recomputes. When the
 * backend clock is playing it already moves, so it is used as is.
 */
export function effectiveNow(live: LiveData, realNowMs: number = Date.now()): number {
  const base = nowOf(live);
  if (!live.clock || live.clock.playing) return base;
  // count from when the backend set the clock (same for every operator, survives reloads);
  // older clock rows without that time fall back to when this browser received the value
  const setAtMs = live.clock.nowSetAtMicros > 0n ? Number(live.clock.nowSetAtMicros / 1000n) : live.clockReceivedAtMs;
  return base + Math.max(0, (realNowMs - setAtMs) / 1000);
}

/** a backend countdown (seconds as of the backend clock) ticked to `now` */
export const tickSeconds = (live: LiveData, seconds: number | undefined, now: number) =>
  seconds === undefined ? undefined : Math.max(0, seconds - (now - nowOf(live)));
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

/** Proactive watch (backend): the healthy tanks that would shut in soonest if their pump stopped now. */
export function watchItems(live: LiveData): PriorityItem[] {
  const now = nowOf(live);
  return live.facilityStates
    .filter((s) => s.watchRank > 0 && s.watchHours >= 0)
    .sort((a, b) => a.watchRank - b.watchRank)
    .map((s): PriorityItem => ({
      id: `watch:${s.facilityId}`,
      asset: live.facilities.find((x) => x.facilityId === s.facilityId)?.tankId ?? s.facilityId,
      facility: s.facilityId,
      systemId: s.systemId,
      category: 'tank_fill',
      onset: now,
      scenario: true,
      title: 'Tank fill exposure',
      severity: 'medium',
      seconds: s.watchHours * 3600,
      detail: 'If the pump stops · constant inflow scenario',
    }));
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
  /** plans with trucks: latest time the dispatch can be called and still prevent the shutdown (earliest facility) */
  latestDispatchUnix?: number | undefined;
  /** first truck arrival if called at plan start */
  firstArrivalUnix?: number | undefined;
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
    latestDispatchUnix: minPositive(facs.map((f) => f.latestDispatchUnix)),
    firstArrivalUnix: minPositive(facs.flatMap((f) => f.truckArrivalsUnix)),
  };
}

/**
 * The ML sidecar's costed fix for this event and option (its cost reasoning explains this
 * facility's share). Options are matched by the sidecar's labels: Recommended -> optimal,
 * Trucks only, Shut in wells only, Do nothing; inspect for leaks and worn pumps.
 */
export function fixFor(live: LiveData, eventId: string | undefined, key: string) {
  if (!eventId) return undefined;
  const rows = live.fixes.filter((f) => f.eventId === eventId);
  return rows.find((f) => f.optionKey === key) ?? (key === 'optimal' ? rows.find((f) => f.optionKey === 'none_needed' || f.optionKey === 'wait') : undefined);
}

/**
 * Why an alert was raised: Hadent's /explain drivers (SHAP, plain English) when the ML sidecar
 * has explained it, otherwise the detector's own evidence.
 */
export function whyFlagged(live: LiveData, eventId: string | undefined): { source: 'model' | 'detector' | 'none'; reasons: string[] } {
  if (!eventId) return { source: 'none', reasons: [] };
  const rows = live.evidence.filter((x) => x.eventId === eventId).sort((a, b) => a.rank - b.rank);
  const shap = rows.filter((r) => r.source === 'shap').map((r) => r.text);
  if (shap.length) return { source: 'model', reasons: shap };
  const det = rows.map((r) => r.text);
  return det.length ? { source: 'detector', reasons: det } : { source: 'none', reasons: [] };
}

/** "2026-10-09T05:00Z - 2 trucks arrive ..." -> { time: "10-09 05:00 UTC", text } (labels like "After the repair -" kept) */
export function parseSequence(entries: string[]): { time: string; text: string }[] {
  return entries.map((e) => {
    const m = e.match(/^(\d{4}-(\d{2}-\d{2})T(\d{2}:\d{2})Z?)\s*-\s*(.*)$/);
    if (m) return { time: `${m[2]} ${m[3]} UTC`, text: m[4] ?? '' };
    const l = e.match(/^([^-]{1,40}?)\s+-\s+(.*)$/);
    return l ? { time: l[1] ?? '', text: l[2] ?? '' } : { time: '', text: e };
  });
}

/**
 * The Nemotron agent's latest briefing for an alert: the system run that covers this pump
 * failure (any event of the same system), or the inspection run for a leak / worn pump,
 * with the crew messages it drafted.
 */
export function agentBriefing(live: LiveData, eventId: string | undefined) {
  if (!eventId) return undefined;
  const ev = live.events.find((e) => e.eventId === eventId);
  if (!ev) return undefined;
  const sameScope = new Set(
    ev.category === 'pump_failure'
      ? live.events.filter((e) => e.systemId === ev.systemId && e.category === 'pump_failure').map((e) => e.eventId)
      : [eventId],
  );
  const run = live.agentRuns
    .filter((r) => sameScope.has(r.eventId) && r.trigger !== 'question' && r.trigger !== 'handoff' && r.status !== 'failed')
    .sort((a, b) => Number(b.startedAt.microsSinceUnixEpoch - a.startedAt.microsSinceUnixEpoch))[0];
  if (!run) return undefined;
  const messages = live.dispatchMessages.filter((m) => m.agentRunId === run.runId).sort((a, b) => Number(a.id - b.id));
  return { run, messages };
}

/** operator questions to the agent, newest first */
export const agentQuestions = (live: LiveData, limit = 5) =>
  [...live.agentQuestions].sort((a, b) => Number(b.createdAt.microsSinceUnixEpoch - a.createdAt.microsSinceUnixEpoch)).slice(0, limit);

/** the newest shift handoff (agent or operator) */
export const latestHandoff = (live: LiveData) =>
  [...live.handoffs].sort((a, b) => Number(b.createdAt.microsSinceUnixEpoch - a.createdAt.microsSinceUnixEpoch))[0];

/** drop options identical to an earlier one (e.g. the optimal plan IS the trucks-only plan) */
export function dedupeOptions(options: DecisionPlan[]): DecisionPlan[] {
  const seen = new Set<string>();
  return options.filter((o) => {
    const key = `${Math.round(o.cost)}|${o.lines.map((l) => `${l.facilityId}:${l.summary}`).join(';')}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * The alternatives to show next to a chosen plan: drop any that repeat the chosen plan or each other
 * (e.g. "trucks only" and "shut-in only" both collapse to "Do nothing" when neither is possible),
 * keeping one per label, the cheapest.
 */
export function distinctAlternatives(chosen: DecisionPlan, others: DecisionPlan[]): DecisionPlan[] {
  const sorted = [...others].sort((a, b) => a.cost - b.cost);
  const unique = dedupeOptions([chosen, ...sorted]).slice(1);
  const labels = new Set([chosen.label]);
  return unique.filter((o) => (labels.has(o.label) ? false : (labels.add(o.label), true)));
}

const minPositive = (xs: number[]) => {
  const v = xs.filter((x) => x > 0);
  return v.length ? Math.min(...v) : undefined;
};

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
  latestDispatchUnix: undefined,
  firstArrivalUnix: undefined,
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

export type TruckStatus = {
  unit: string;
  status: 'Standby' | 'En route' | 'Hauling';
  facility?: string;
  /** dispatched (plan start) */
  dispatch?: number;
  eta?: number;
  back?: number;
  trips?: number;
  /** 0..1 through the whole job: dispatch -> back at the yard */
  progress?: number;
  /** 0..1 position of the arrival at the facility on that bar */
  arrivalAt?: number;
};

/** Each truck's status from the APPROVED plans of the fleet's system (trucks dispatched at plan start). */
export function fleetTrucks(live: LiveData, fleet: Fleet, now: number = nowOf(live)): TruckStatus[] {
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
        const span = Math.max(1, back - p.planStartUnix);
        trucks[next] = {
          unit: `TRK-${fleet.id}-${String.fromCharCode(65 + next)}`,
          status: now < eta ? 'En route' : 'Hauling',
          facility: a.facilityId,
          dispatch: p.planStartUnix,
          eta,
          back,
          trips: a.tripsPerTruck,
          progress: Math.min(1, Math.max(0, (now - p.planStartUnix) / span)),
          arrivalAt: Math.min(1, Math.max(0, (eta - p.planStartUnix) / span)),
        };
        next++;
      }
    }
  }
  return trucks;
}

export interface Recommendation {
  kind: 'temporary' | 'long_term';
  from: string;
  to: string;
  km: number;
  reason: string;
}

/** Fleet advice computed by the backend (fleet_recommendation table). */
export function recommendations(live: LiveData): Recommendation[] {
  return live.fleetRecommendations
    .map((r) => ({ kind: r.kind as Recommendation['kind'], from: r.fromSystem, to: r.toSystem, km: r.km, reason: r.reason }))
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.to.localeCompare(b.to));
}

const usd = (v: number) => `$${Math.round(v).toLocaleString('en-US')}`;

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
    const ev = whyFlagged(live, e.eventId).reasons[0];
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
  /** beehive geographic view: compressed geography, honeycomb, truck routes, system cards, overview */
  geo: GeoModel;
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

  const geo = geoLayout(live, nodes, edges, W, H);
  return { W, H, nodes, edges, boxes, geoNodes: geo.nodes, geoEdges: geo.edges, geo };
}

export const headerSummary = (live: LiveData) => ({ now: nowOf(live), alerts: ongoingEvents(live).length });
