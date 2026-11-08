// Shutdown countdown for a failed pump. Physics (SPEC.md):
//   level change per hour = (inflow - pump flow) / 24 / capacity * 100
import type { DatasetModel } from './model';
import type { Grid } from './telemetry';

export interface Countdown {
  facilityId: string;
  asOfUnix: number;
  levelPct: number; // tank level at asOfUnix
  inflowBpd: number; // inflow used by the physics model
  ratePctPerHour: number;
  /** null if the level is not rising */
  hoursToLimitP50: number | null;
  hoursToLimitP10: number | null;
  hoursToLimitP90: number | null;
  /** asOfUnix + p50 hours, null if not rising */
  tripsAtUnix: number | null;
  /** tank is already at shutdown (wells shut in) */
  alreadyTripped: boolean;
}

export function countdownAt(_model: DatasetModel, _grid: Grid, _facilityId: string, _asOfUnix: number): Countdown {
  throw new Error('countdownAt: not implemented yet');
}
