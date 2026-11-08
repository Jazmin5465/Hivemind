// Rules-based detector (fallback when the ML sidecar is down; baseline for Hadent).
// CONTRACT:
//  - Pure, causal: reads only grid indices whose ts <= asOfUnix.
//  - Prefix-consistent: once an event is emitted, its onsetUnix never changes as asOfUnix grows.
//  - No hardcoded IDs / thresholds tied to one network: normalise by network.json specs.
import type { DatasetModel } from '../model';
import type { Grid } from '../telemetry';
import type { DetectedEvent } from '../types';

export interface RulesOptions {
  /** defaults to the last ts in the grid ("now") */
  asOfUnix?: number;
}

export function detectRules(_model: DatasetModel, _grid: Grid, _opts: RulesOptions = {}): DetectedEvent[] {
  throw new Error('detectRules: not implemented yet');
}
