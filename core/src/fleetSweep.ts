// "How big should the trucking fleet be?" Replay every pump failure (detected as of asOfUnix)
// in onset order, planning each one at its onset with earlier plans followed (their trucks
// stay busy), for a range of fleet sizes. Same rules as full_week's reference plans.
import type { DatasetModel } from './model';
import type { Grid } from './telemetry';
import type { DetectedEvent } from './types';
import { countdownAt } from './countdown';
import { planSystem } from './planner';

export interface FleetSweepRow {
  systemId: string;
  fleetSize: number;
  isCurrent: boolean;
  failures: number;
  totalCost: number;
  /** failures whose tank still trips under the plan */
  trips: number;
  truckTrips: number;
  wellsShutIn: number;
}

export function fleetSweep(
  model: DatasetModel,
  grid: Grid,
  events: DetectedEvent[],
  opts: { extraSizes?: number; asOfUnix: number },
): FleetSweepRow[] {
  const rows: FleetSweepRow[] = [];
  const fails = events.filter((e) => e.category === 'pump_failure' && e.onsetUnix <= opts.asOfUnix).sort((a, b) => a.onsetUnix - b.onsetUnix);
  for (const sys of model.systems) {
    const evs = fails.filter((e) => e.systemId === sys.id);
    const maxSize = sys.fleetSize + (opts.extraSizes ?? 2);
    for (let F = 0; F <= maxSize; F++) {
      const busy: number[] = [];
      let total = 0;
      let trips = 0;
      let truckTrips = 0;
      let wells = 0;
      for (const e of evs) {
        const cd = countdownAt(model, grid, e.facilityId, e.onsetUnix, { sinceUnix: e.onsetUnix });
        const plan = planSystem({
          model,
          systemId: sys.id,
          nowUnix: e.onsetUnix,
          failures: [{ eventId: 'x', facilityId: e.facilityId, levelPct: cd.levelPct, repairEndUnix: e.onsetUnix + model.repairHoursPumpFailure * 3600, alreadyTripped: cd.alreadyTripped }],
          overrides: { fleetSize: F },
          busyTruckFreeAtUnix: busy.filter((t) => t > e.onsetUnix),
        });
        const f = plan.facilities[0];
        total += f.cost;
        if (f.tripsAtUnix !== null) trips++;
        truckTrips += f.trucks * f.tripsPerTruck;
        wells += f.shutInWells.length;
        busy.push(...f.truckFreeAtUnix);
      }
      rows.push({ systemId: sys.id, fleetSize: F, isCurrent: F === sys.fleetSize, failures: evs.length, totalCost: total, trips, truckTrips, wellsShutIn: wells });
    }
  }
  return rows;
}
