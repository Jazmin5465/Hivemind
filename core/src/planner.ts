// Exact joint planner for all ongoing pump failures in one system (shared truck fleet).
import type { DatasetModel } from './model';
import type { PlanAction } from './types';

export interface FailureInput {
  eventId: string;
  facilityId: string;
  /** tank level at plan start (percent) */
  levelPct: number;
  /** onset + expected_repair_hours */
  repairEndUnix: number;
  /** true if the tank has already reached shutdown at plan start */
  alreadyTripped?: boolean;
}

export interface PlanOverrides {
  fleetSize?: number;
  repairHours?: number; // replaces expected_repair_hours.pump_failure
  extraRepairHours?: number; // added to each failure's repair end
  truckCapacityBbl?: number;
  costPerTrip?: number;
  /** wells that may not be shut in */
  lockedWells?: string[];
}

export interface PlanInput {
  model: DatasetModel;
  systemId: string;
  nowUnix: number; // plan start
  failures: FailureInput[];
  overrides?: PlanOverrides;
  /** trucks already busy on earlier plans: unix time each becomes free. Busy trucks can't be used. */
  busyTruckFreeAtUnix?: number[];
  /** failure onset per event (for horizon when repairHours overridden) */
  onsetUnixByEvent?: Record<string, number>;
}

export interface FacilityPlan {
  eventId: string;
  facilityId: string;
  actions: PlanAction[];
  cost: number;
  doNothingCost: number;
  /** when the tank would trip if nothing were done (null = never before repair) */
  tripsAtUnixIfNothing: number | null;
  /** when the tank trips under this plan (null = prevented) */
  tripsAtUnix: number | null;
  peakLevelPct: number;
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

export function planSystem(_input: PlanInput): SystemPlan {
  throw new Error('planSystem: not implemented yet');
}
