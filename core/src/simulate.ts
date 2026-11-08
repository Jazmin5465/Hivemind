// Single source of truth for tank physics under a plan (failed pump, flow = 0).
// Used by the planner (search), by plan validation in the module, and by what-ifs.
//
// SPEC.md rules implemented here:
//  - level change per hour = (inflow - pump flow) / 24 / capacity * 100, pump flow = 0 while failed
//  - all trucks in a plan are called at plan start; first trip arrives response_min later,
//    then one every cycle_min; each truck removes truck_capacity_bbl per trip
//  - water is removed only when a trip arrives; a trip can't remove more than is in the tank
//  - every trip must arrive before the repair ends
//  - a truck is busy until cycle_min after its last trip
//  - shut-in is instant, can start late, lasts until the repair ends
//  - reaching the shutdown level trips the tank: all wells shut in until the repair ends

export interface TankParams {
  capacityBbl: number;
  shutdownPct: number;
  /** level at plan start */
  levelPct: number;
  /** inflow (bbl/day) with every currently-producing well on */
  inflowBpd: number;
  /** minutes from plan start to repair end */
  horizonMin: number;
  /** revenue per hour of the whole facility (lost while tripped) */
  facilityRevenuePerHour: number;
}

export interface TruckParams {
  trucks: number;
  tripsPerTruck: number;
  responseMin: number;
  cycleMin: number;
  capacityBbl: number;
  costPerTrip: number;
}

export interface ShutInParams {
  /** water (bbl/day) removed from inflow by the shut-in wells */
  waterBpd: number;
  /** revenue per hour of the shut-in wells */
  revenuePerHour: number;
  /** minutes after plan start */
  startMin: number;
}

export interface SimResult {
  /** minutes after plan start when the tank trips; null = never before repair end */
  tripMin: number | null;
  peakLevelPct: number;
  /** trip arrival minutes that are valid (before repair end) */
  arrivalsMin: number[];
  /** problems with the plan itself (not tripping): trips after repair end etc. */
  violations: string[];
  truckCost: number;
  shutInCost: number;
  /** lost revenue from an automatic trip (0 if prevented) */
  tripCost: number;
  totalCost: number;
}

const EPS = 1e-9;

export function tripArrivals(t: TruckParams | null): number[] {
  if (!t || t.trucks <= 0 || t.tripsPerTruck <= 0) return [];
  const out: number[] = [];
  for (let j = 0; j < t.tripsPerTruck; j++) out.push(t.responseMin + j * t.cycleMin);
  return out;
}

/** Simulate one facility. Optionally returns a level trace sampled every traceStepMin. */
export function simulateTank(
  tank: TankParams,
  trucks: TruckParams | null,
  shutIn: ShutInParams | null,
  traceStepMin = 0,
): SimResult & { trace: number[] } {
  const cap = tank.capacityBbl;
  const vShut = (tank.shutdownPct / 100) * cap;
  const T = tank.horizonMin;
  const q = tank.inflowBpd / 1440; // bbl per minute
  const qW = shutIn ? Math.min(shutIn.waterBpd, tank.inflowBpd) / 1440 : 0;
  const s = shutIn ? Math.max(0, shutIn.startMin) : Infinity;
  const violations: string[] = [];
  const arrivals = tripArrivals(trucks);
  const validArrivals = arrivals.filter((a) => a < T - EPS);
  if (validArrivals.length < arrivals.length) violations.push(`${arrivals.length - validArrivals.length} truck trip(s) arrive after the repair ends`);
  if (shutIn && shutIn.waterBpd > tank.inflowBpd + EPS) violations.push('shut-in wells exceed the facility inflow');

  const inflowBetween = (a: number, b: number) => {
    // volume entering between minutes a < b
    if (b <= a) return 0;
    if (s >= b) return q * (b - a);
    if (s <= a) return (q - qW) * (b - a);
    return q * (s - a) + (q - qW) * (b - s);
  };

  let V = (tank.levelPct / 100) * cap;
  let t = 0;
  let peak = V;
  let tripMin: number | null = null;
  const trace: number[] = [];
  let nextTrace = 0;

  // walk segments; record trace samples (pre-removal at arrival instants is fine for a chart)
  const stops = [...validArrivals, T];
  const perArrivalBbl = (trucks?.trucks ?? 0) * (trucks?.capacityBbl ?? 0);
  if (V >= vShut - EPS) tripMin = 0;

  for (let i = 0; i < stops.length && tripMin === null; i++) {
    const b = stops[i];
    if (traceStepMin > 0) {
      while (nextTrace <= b + EPS && nextTrace <= T + EPS) {
        trace.push(((V + inflowBetween(t, nextTrace)) / cap) * 100);
        nextTrace += traceStepMin;
      }
    }
    const Vb = V + inflowBetween(t, b);
    if (Vb >= vShut - EPS) {
      // find crossing minute inside (t, b]
      let lo = t;
      let hi = b;
      for (let it = 0; it < 60; it++) {
        const mid = (lo + hi) / 2;
        if (V + inflowBetween(t, mid) >= vShut - EPS) hi = mid;
        else lo = mid;
      }
      tripMin = hi;
      peak = vShut;
      break;
    }
    peak = Math.max(peak, Vb);
    V = Vb;
    t = b;
    if (i < validArrivals.length) V -= Math.min(perArrivalBbl, V);
  }
  if (tripMin !== null && traceStepMin > 0) {
    // tank holds at shutdown until repair end
    while (nextTrace <= T + EPS) {
      trace.push(tank.shutdownPct);
      nextTrace += traceStepMin;
    }
  }

  const trips = (trucks?.trucks ?? 0) * validArrivals.length;
  const truckCost = trips * (trucks?.costPerTrip ?? 0);
  // shut-in costs until repair end, or until the automatic trip shuts everything anyway
  const shutEnd = tripMin ?? T;
  const shutInCost = shutIn && s < shutEnd ? (shutIn.revenuePerHour * (shutEnd - s)) / 60 : 0;
  const tripCost = tripMin !== null ? (tank.facilityRevenuePerHour * (T - tripMin)) / 60 : 0;
  return {
    tripMin,
    peakLevelPct: (peak / cap) * 100,
    arrivalsMin: validArrivals,
    violations,
    truckCost,
    shutInCost,
    tripCost,
    totalCost: truckCost + shutInCost + tripCost,
    trace,
  };
}
