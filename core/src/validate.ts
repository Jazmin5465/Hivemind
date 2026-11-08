// Re-validate any plan (planner, agent or operator-edited) against SPEC.md rules using the
// same simulator the planner uses. The module runs this before storing or approving a plan.
import type { DatasetModel } from './model';
import type { PlanAction } from './types';
import type { FailureInput, PlanOverrides } from './planner';
import { simulateTank, type SimResult } from './simulate';

export interface ValidateInput {
  model: DatasetModel;
  systemId: string;
  nowUnix: number;
  failures: FailureInput[];
  /** actions for any of the failures' facilities */
  actions: (PlanAction & { eventId?: string })[];
  busyTruckFreeAtUnix?: number[];
  overrides?: PlanOverrides;
}

export interface FacilityCheck {
  eventId: string;
  facilityId: string;
  sim: SimResult;
  trucks: number;
  tripsPerTruck: number;
  wells: string[];
  startAfterMin: number;
  truckFreeAtUnix: number[];
}

export interface ValidateResult {
  valid: boolean;
  errors: string[];
  totalCost: number;
  trucksUsed: number;
  trucksAvailable: number;
  facilities: FacilityCheck[];
}

export function validatePlan(input: ValidateInput): ValidateResult {
  const { model, nowUnix } = input;
  const o = input.overrides ?? {};
  const errors: string[] = [];
  const sys = model.systemById.get(input.systemId);
  if (!sys) return { valid: false, errors: [`unknown system ${input.systemId}`], totalCost: 0, trucksUsed: 0, trucksAvailable: 0, facilities: [] };
  const fleet = o.fleetSize ?? sys.fleetSize;
  const busy = (input.busyTruckFreeAtUnix ?? []).filter((t) => t > nowUnix).length;
  const available = o.noTrucks ? 0 : Math.max(0, fleet - busy);
  const byFacility = new Map(input.failures.map((f) => [f.facilityId, f]));

  for (const a of input.actions) {
    if (a.type === 'field_inspection' || a.type === 'none') continue;
    if (!a.facilityId || !byFacility.has(a.facilityId)) errors.push(`${a.type} targets ${a.facilityId ?? '?'}, which has no ongoing pump failure in ${input.systemId}`);
    const fac = a.facilityId ? model.facilityById.get(a.facilityId) : undefined;
    if (fac && fac.systemId !== input.systemId) errors.push(`${a.facilityId} is not in system ${input.systemId}`);
    if (a.type === 'dispatch_truck') {
      if (!Number.isInteger(a.trucks) || (a.trucks ?? 0) < 1) errors.push(`dispatch_truck at ${a.facilityId}: trucks must be a positive integer`);
      if (!Number.isInteger(a.tripsPerTruck) || (a.tripsPerTruck ?? 0) < 1) errors.push(`dispatch_truck at ${a.facilityId}: trips_per_truck must be a positive integer`);
    }
    if (a.type === 'shut_in_wells' && fac) {
      for (const w of a.wells ?? []) if (!fac.wells.some((x) => x.id === w)) errors.push(`well ${w} is not at ${fac.id}`);
      if ((a.startAfterMin ?? 0) < 0) errors.push(`shut-in start must be >= 0`);
    }
  }

  let trucksUsed = 0;
  let totalCost = 0;
  const facilities: FacilityCheck[] = [];
  for (const f of input.failures) {
    const fac = model.facilityById.get(f.facilityId);
    if (!fac) {
      errors.push(`unknown facility ${f.facilityId}`);
      continue;
    }
    const acts = input.actions.filter((a) => a.facilityId === f.facilityId);
    const truckActs = acts.filter((a) => a.type === 'dispatch_truck');
    const shutActs = acts.filter((a) => a.type === 'shut_in_wells');
    if (truckActs.length > 1) errors.push(`${f.facilityId}: more than one dispatch_truck action`);
    if (shutActs.length > 1) errors.push(`${f.facilityId}: more than one shut_in_wells action`);
    const k = truckActs[0]?.trucks ?? 0;
    const n = truckActs[0]?.tripsPerTruck ?? 0;
    trucksUsed += k;
    let repairEnd = f.repairEndUnix + (o.extraRepairHours ?? 0) * 3600;
    const off = new Set(f.wellsOff ?? []);
    const producing = fac.wells.filter((w) => !off.has(w.id));
    const wells = (shutActs[0]?.wells ?? []).filter((w) => producing.some((p) => p.id === w));
    const startMin = shutActs[0]?.startAfterMin ?? 0;
    if (o.lockedWells?.length) for (const w of wells) if (o.lockedWells.includes(w)) errors.push(`well ${w} is locked and can't be shut in`);
    const sim = simulateTank(
      {
        capacityBbl: fac.capacityBbl,
        shutdownPct: model.shutdownPct,
        levelPct: f.levelPct,
        inflowBpd: f.alreadyTripped ? 0 : producing.reduce((a, w) => a + w.baselineWaterBpd, 0),
        horizonMin: Math.max(0, (repairEnd - nowUnix) / 60),
        facilityRevenuePerHour: producing.reduce((a, w) => a + w.revenuePerHour, 0),
      },
      k > 0 && n > 0
        ? { trucks: k, tripsPerTruck: n, responseMin: fac.responseMin, cycleMin: fac.cycleMin, capacityBbl: o.truckCapacityBbl ?? model.truckCapacityBbl, costPerTrip: o.costPerTrip ?? model.costPerTrip }
        : null,
      wells.length
        ? {
            waterBpd: wells.reduce((a, id) => a + model.wellById.get(id)!.baselineWaterBpd, 0),
            revenuePerHour: wells.reduce((a, id) => a + model.wellById.get(id)!.revenuePerHour, 0),
            startMin,
          }
        : null,
    );
    for (const v of sim.violations) errors.push(`${f.facilityId}: ${v}`);
    if (sim.tripMin !== null && (k > 0 || wells.length > 0))
      errors.push(`${f.facilityId}: tank still reaches shutdown at +${Math.round(sim.tripMin)} min under this plan`);
    const lastArr = sim.arrivalsMin.length ? sim.arrivalsMin[sim.arrivalsMin.length - 1] : null;
    const freeAt = lastArr !== null ? nowUnix + (lastArr + fac.cycleMin) * 60 : null;
    facilities.push({
      eventId: f.eventId,
      facilityId: f.facilityId,
      sim,
      trucks: k,
      tripsPerTruck: n,
      wells,
      startAfterMin: startMin,
      truckFreeAtUnix: freeAt !== null ? new Array(k).fill(freeAt) : [],
    });
    totalCost += sim.totalCost;
  }
  if (trucksUsed > available) errors.push(`plan uses ${trucksUsed} trucks but only ${available} of ${fleet} are free in ${input.systemId}`);
  return { valid: errors.length === 0, errors, totalCost, trucksUsed, trucksAvailable: available, facilities };
}
