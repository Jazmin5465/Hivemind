// Exact joint planner for all ongoing pump failures in one system (shared truck fleet).
//
// Search space per facility: k trucks (0..available) x n trips per truck (arrivals before
// repair end) x any subset of wells to shut in, with the shut-in start chosen as the
// LATEST whole minute that still keeps the tank below shutdown (cost is decreasing in the
// start time and feasibility is monotone, so a binary search over minutes is exact).
// Plus "do nothing" (accept the automatic trip). Facilities are combined with an exact
// DP over how many trucks each one gets (sum <= trucks free at plan start).
import type { DatasetModel, Facility } from './model';
import type { PlanAction } from './types';
import { simulateTank, type ShutInParams, type TankParams, type TruckParams } from './simulate';

export interface FailureInput {
  eventId: string;
  facilityId: string;
  /** tank level at plan start (percent) */
  levelPct: number;
  /** onset + expected_repair_hours */
  repairEndUnix: number;
  /** true if the tank has already reached shutdown at plan start */
  alreadyTripped?: boolean;
  /** wells already shut in at plan start (excluded from inflow); default none */
  wellsOff?: string[];
}

export interface PlanOverrides {
  fleetSize?: number;
  repairHours?: number; // replaces expected_repair_hours.pump_failure (needs onsetUnixByEvent)
  extraRepairHours?: number; // added to each failure's repair end
  truckCapacityBbl?: number;
  costPerTrip?: number;
  /** wells that may not be shut in */
  lockedWells?: string[];
  /** forbid trucks entirely (e.g. "what if the yard is closed") */
  noTrucks?: boolean;
}

export interface PlanInput {
  model: DatasetModel;
  systemId: string;
  nowUnix: number; // plan start
  failures: FailureInput[];
  overrides?: PlanOverrides;
  /** trucks already busy on earlier plans: unix time each becomes free. Busy trucks can't be used. */
  busyTruckFreeAtUnix?: number[];
  /** failure onset per event (needed when overrides.repairHours is set) */
  onsetUnixByEvent?: Record<string, number>;
}

export interface FacilityPlan {
  eventId: string;
  facilityId: string;
  actions: PlanAction[];
  cost: number;
  truckCost: number;
  shutInCost: number;
  tripCost: number;
  doNothingCost: number;
  /** when the tank would trip if nothing were done (null = never before repair) */
  tripsAtUnixIfNothing: number | null;
  /** when the tank trips under this plan (null = prevented) */
  tripsAtUnix: number | null;
  peakLevelPct: number;
  repairEndUnix: number;
  trucks: number;
  tripsPerTruck: number;
  shutInWells: string[];
  shutInStartUnix: number | null;
  /** truck arrival times (unix) under this plan */
  truckArrivalsUnix: number[];
  /** unix time each dispatched truck is free again */
  truckFreeAtUnix: number[];
  /** level trace on a 5-min grid from plan start to repair end */
  levelTrace: { t0: number; stepSec: number; values: number[] };
  summary: string;
}

export interface SystemPlan {
  systemId: string;
  nowUnix: number;
  fleetSize: number;
  trucksAvailable: number;
  totalCost: number;
  doNothingCost: number;
  facilities: FacilityPlan[];
  stats: { evaluated: number; ms: number };
}

interface Candidate {
  trucks: number;
  trips: number;
  wells: string[];
  startMin: number | null; // shut-in start
  cost: number;
  prevents: boolean;
}

interface FacilityCtx {
  failure: FailureInput;
  fac: Facility;
  tank: TankParams;
  repairEndUnix: number;
  truckBase: Omit<TruckParams, 'trucks' | 'tripsPerTruck'>;
  /** shut-in-able wells (producing, not locked) */
  wells: Facility['wells'];
}

const TRACE_STEP_MIN = 5;
const EPS = 1e-6;

function buildCtx(input: PlanInput, f: FailureInput): FacilityCtx {
  const { model } = input;
  const fac = model.facilityById.get(f.facilityId);
  if (!fac) throw new Error(`unknown facility ${f.facilityId}`);
  const o = input.overrides ?? {};
  let repairEnd = f.repairEndUnix;
  if (o.repairHours != null) {
    const onset = input.onsetUnixByEvent?.[f.eventId];
    if (onset != null) repairEnd = onset + o.repairHours * 3600;
  }
  if (o.extraRepairHours) repairEnd += o.extraRepairHours * 3600;
  const off = new Set(f.wellsOff ?? []);
  const producing = fac.wells.filter((w) => !off.has(w.id));
  const locked = new Set(o.lockedWells ?? []);
  return {
    failure: f,
    fac,
    repairEndUnix: repairEnd,
    tank: {
      capacityBbl: fac.capacityBbl,
      shutdownPct: model.shutdownPct,
      levelPct: f.levelPct,
      inflowBpd: f.alreadyTripped ? 0 : producing.reduce((a, w) => a + w.baselineWaterBpd, 0),
      horizonMin: Math.max(0, (repairEnd - input.nowUnix) / 60),
      facilityRevenuePerHour: producing.reduce((a, w) => a + w.revenuePerHour, 0),
    },
    truckBase: {
      responseMin: fac.responseMin,
      cycleMin: fac.cycleMin,
      capacityBbl: o.truckCapacityBbl ?? model.truckCapacityBbl,
      costPerTrip: o.costPerTrip ?? model.costPerTrip,
    },
    wells: producing.filter((w) => !locked.has(w.id)),
  };
}

function shutInFor(ctx: FacilityCtx, wellIdx: number[], startMin: number): ShutInParams {
  let water = 0;
  let rev = 0;
  for (const i of wellIdx) {
    water += ctx.wells[i].baselineWaterBpd;
    rev += ctx.wells[i].revenuePerHour;
  }
  return { waterBpd: water, revenuePerHour: rev, startMin };
}

/** Best candidates for one facility, indexed by exact truck count 0..maxTrucks. */
function facilityCandidates(ctx: FacilityCtx, maxTrucks: number, counter: { n: number }): (Candidate | null)[] {
  const { tank, truckBase } = ctx;
  const T = tank.horizonMin;
  const best: (Candidate | null)[] = new Array(maxTrucks + 1).fill(null);
  const consider = (k: number, c: Candidate) => {
    const cur = best[k];
    if (
      !cur ||
      c.cost < cur.cost - EPS ||
      (Math.abs(c.cost - cur.cost) <= EPS && tieBetter(c, cur))
    )
      best[k] = c;
  };

  // do nothing
  const nothing = simulateTank(tank, null, null);
  counter.n++;
  consider(0, { trucks: 0, trips: 0, wells: [], startMin: null, cost: nothing.totalCost, prevents: nothing.tripMin === null });
  if (nothing.tripMin === null || T <= 0 || ctx.failure.alreadyTripped) return best;

  // max useful trips per truck: arrivals strictly before repair end
  let nMax = 0;
  while (truckBase.responseMin + nMax * truckBase.cycleMin < T - 1e-9) nMax++;

  const W = ctx.wells.length;
  const subsets = 1 << W;
  for (let k = 0; k <= maxTrucks; k++) {
    const tripOptions = k === 0 ? [0] : Array.from({ length: nMax }, (_, i) => i + 1);
    for (const n of tripOptions) {
      const trucks: TruckParams | null = k > 0 ? { ...truckBase, trucks: k, tripsPerTruck: n } : null;
      const truckCost = k * n * truckBase.costPerTrip;
      // trucks alone
      const alone = simulateTank(tank, trucks, null);
      counter.n++;
      if (alone.tripMin === null) {
        consider(k, { trucks: k, trips: n, wells: [], startMin: null, cost: truckCost, prevents: true });
        continue; // adding shut-ins only adds cost
      }
      for (let mask = 1; mask < subsets; mask++) {
        const idx: number[] = [];
        for (let i = 0; i < W; i++) if (mask & (1 << i)) idx.push(i);
        // feasible at start 0?
        const at0 = simulateTank(tank, trucks, shutInFor(ctx, idx, 0));
        counter.n++;
        if (at0.tripMin !== null) continue;
        // latest whole minute that still prevents the trip
        let lo = 0;
        let hi = Math.max(0, Math.ceil(T));
        while (lo < hi) {
          const mid = Math.floor((lo + hi + 1) / 2); // upper mid: lo is always feasible
          const r = simulateTank(tank, trucks, shutInFor(ctx, idx, mid));
          counter.n++;
          if (r.tripMin === null) lo = mid;
          else hi = mid - 1;
        }
        const si = shutInFor(ctx, idx, lo);
        const shutCost = (si.revenuePerHour * Math.max(0, T - lo)) / 60;
        consider(k, {
          trucks: k,
          trips: n,
          wells: idx.map((i) => ctx.wells[i].id),
          startMin: lo,
          cost: truckCost + shutCost,
          prevents: true,
        });
      }
    }
  }
  return best;
}

/** tie-break among equal-cost plans: fewer trucks, then fewer trips, then fewer wells shut in */
function tieBetter(a: Candidate, b: Candidate): boolean {
  if (a.trucks !== b.trucks) return a.trucks < b.trucks;
  if (a.trucks * a.trips !== b.trucks * b.trips) return a.trucks * a.trips < b.trucks * b.trips;
  return a.wells.length < b.wells.length;
}

function describe(ctx: FacilityCtx, c: Candidate, nothingTripMin: number | null): string {
  const parts: string[] = [];
  if (c.trucks > 0)
    parts.push(`${c.trucks} truck${c.trucks > 1 ? 's' : ''}, ${c.trips} trip${c.trips > 1 ? 's' : ''}${c.trucks > 1 ? ' each' : ''}`);
  if (c.wells.length) parts.push(`shut in ${c.wells.join(', ')} at +${c.startMin} min`);
  if (!parts.length) {
    if (nothingTripMin === null) return 'none (tank stays below shutdown until the repair ends)';
    return `none (accept automatic shut-in at +${Math.round(nothingTripMin)} min)`;
  }
  return parts.join(' + ');
}

function materialize(input: PlanInput, ctx: FacilityCtx, c: Candidate): FacilityPlan {
  const now = input.nowUnix;
  const trucks: TruckParams | null = c.trucks > 0 ? { ...ctx.truckBase, trucks: c.trucks, tripsPerTruck: c.trips } : null;
  const shut = c.wells.length
    ? shutInFor(ctx, c.wells.map((id) => ctx.wells.findIndex((w) => w.id === id)), c.startMin ?? 0)
    : null;
  const sim = simulateTank(ctx.tank, trucks, shut, TRACE_STEP_MIN);
  const nothing = simulateTank(ctx.tank, null, null);
  const actions: PlanAction[] = [];
  if (c.trucks > 0) actions.push({ type: 'dispatch_truck', facilityId: ctx.fac.id, trucks: c.trucks, tripsPerTruck: c.trips });
  if (c.wells.length) actions.push({ type: 'shut_in_wells', facilityId: ctx.fac.id, wells: c.wells, startAfterMin: c.startMin ?? 0 });
  if (!actions.length) actions.push({ type: 'none', facilityId: ctx.fac.id });
  const arrivalsUnix = sim.arrivalsMin.map((m) => now + m * 60);
  const lastArrival = sim.arrivalsMin.length ? sim.arrivalsMin[sim.arrivalsMin.length - 1] : null;
  const freeAt = lastArrival !== null ? now + (lastArrival + ctx.truckBase.cycleMin) * 60 : null;
  return {
    eventId: ctx.failure.eventId,
    facilityId: ctx.fac.id,
    actions,
    cost: sim.totalCost,
    truckCost: sim.truckCost,
    shutInCost: sim.shutInCost,
    tripCost: sim.tripCost,
    doNothingCost: nothing.totalCost,
    tripsAtUnixIfNothing: nothing.tripMin === null ? null : now + nothing.tripMin * 60,
    tripsAtUnix: sim.tripMin === null ? null : now + sim.tripMin * 60,
    peakLevelPct: sim.peakLevelPct,
    repairEndUnix: ctx.repairEndUnix,
    trucks: c.trucks,
    tripsPerTruck: c.trips,
    shutInWells: c.wells,
    shutInStartUnix: c.wells.length ? now + (c.startMin ?? 0) * 60 : null,
    truckArrivalsUnix: arrivalsUnix,
    truckFreeAtUnix: freeAt !== null ? new Array(c.trucks).fill(freeAt) : [],
    levelTrace: { t0: now, stepSec: TRACE_STEP_MIN * 60, values: sim.trace.map((v) => Math.round(v * 100) / 100) },
    summary: describe(ctx, c, nothing.tripMin),
  };
}

export function planSystem(input: PlanInput): SystemPlan {
  const t0 = Date.now();
  const sys = input.model.systemById.get(input.systemId);
  if (!sys) throw new Error(`unknown system ${input.systemId}`);
  const o = input.overrides ?? {};
  const fleet = o.fleetSize ?? sys.fleetSize;
  const busy = (input.busyTruckFreeAtUnix ?? []).filter((t) => t > input.nowUnix).length;
  const available = o.noTrucks ? 0 : Math.max(0, fleet - busy);
  const counter = { n: 0 };

  const ctxs = input.failures.map((f) => buildCtx(input, f));
  const cands = ctxs.map((c) => facilityCandidates(c, available, counter));

  // exact DP over truck allocation: dp[j][used] = min cost for first j facilities
  type Cell = { cost: number; trucks: number; pick: number[] } | null;
  let dp: Cell[] = new Array(available + 1).fill(null);
  dp[0] = { cost: 0, trucks: 0, pick: [] };
  for (let j = 0; j < ctxs.length; j++) {
    const next: Cell[] = new Array(available + 1).fill(null);
    for (let used = 0; used <= available; used++) {
      const cell = dp[used];
      if (!cell) continue;
      for (let k = 0; used + k <= available; k++) {
        const c = cands[j][k];
        if (!c) continue;
        const cost = cell.cost + c.cost;
        const u = used + k;
        const cur = next[u];
        if (!cur || cost < cur.cost - EPS) next[u] = { cost, trucks: u, pick: [...cell.pick, k] };
      }
    }
    dp = next;
  }
  let bestCell: Cell = null;
  for (const cell of dp) {
    if (!cell) continue;
    if (!bestCell || cell.cost < bestCell.cost - EPS || (Math.abs(cell.cost - bestCell.cost) <= EPS && cell.trucks < bestCell.trucks)) bestCell = cell;
  }
  const facilities = ctxs.map((ctx, j) => materialize(input, ctx, cands[j][bestCell!.pick[j]]!));
  return {
    systemId: input.systemId,
    nowUnix: input.nowUnix,
    fleetSize: fleet,
    trucksAvailable: available,
    totalCost: facilities.reduce((a, f) => a + f.cost, 0),
    doNothingCost: facilities.reduce((a, f) => a + f.doNothingCost, 0),
    facilities,
    stats: { evaluated: counter.n, ms: Date.now() - t0 },
  };
}
