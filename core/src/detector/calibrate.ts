// Causal self-calibration of the healthy pressure offsets and the pressure noise.
//
// SPEC documents healthy pressures as disposal + 50 (pipeline) and + 150 (discharge) while
// pumping, but calls the offsets "placeholders". So instead of trusting them blindly we start
// from the documented values and replace them with estimates from the data, step by step:
//   offset   = running mean of the per-step MEDIAN of (reading - disposal) over all pumps that
//              are running at that step, network-wide. The median across peers ignores the few
//              pumps / pipelines that have a problem at any one time, and slow drifts in one
//              pump can't drag it.
//   noise    = RMS of (reading - disposal) over stopped pumps (healthy by physics: both
//              pressures sit at the disposal pressure when the pump is off).
// Every value at step i uses data <= i only, so this keeps the detector causal and
// prefix-consistent.
import type { DatasetModel } from '../model';
import { gridGet, type Grid } from '../telemetry';
import { DISCHARGE_RUN_OFFSET_PSI, PIPE_RUN_OFFSET_PSI, PUMP_FAULT, PUMP_RUNNING } from './constants';

export interface Calibration {
  /** healthy pipeline pressure above disposal while pumping (psi), estimated at each step */
  pipeOffset: Float64Array;
  /** healthy discharge pressure above disposal while pumping (psi) */
  dischargeOffset: Float64Array;
  /** 1-sigma noise of a single pressure reading (psi) */
  pressureNoise: Float64Array;
  /** 1 once enough peer medians have been seen for the offsets to be trusted */
  ready: Uint8Array;
}

/** Peers needed at one step for its median to count (fewer peers = no robust median). */
const MIN_PEERS = 3;
/** Peer medians needed before pressure-based scores are used (1 h of 5-minute steps). */
const MIN_MEDIANS = 12;
/** Prior noise, as a fraction of the documented pipeline offset (~3 psi), and its weight in readings. */
const NOISE_PRIOR_FRAC = 0.06;
const NOISE_PRIOR_WEIGHT = 20;

export function calibrate(model: DatasetModel, grid: Grid, last: number): Calibration {
  const n = last + 1;
  const pipeOffset = new Float64Array(n);
  const dischargeOffset = new Float64Array(n);
  const pressureNoise = new Float64Array(n);
  const ready = new Uint8Array(n);

  const facs = model.facilities
    .map((f) => ({
      disp: model.systemById.get(f.systemId)?.disposalPressurePsi ?? NaN,
      st: gridGet(grid, f.pumpId, 'status'),
      dp: gridGet(grid, f.pumpId, 'discharge_psi'),
      pp: gridGet(grid, f.pipelineId, 'pressure_psi'),
    }))
    .filter((x) => Number.isFinite(x.disp) && x.st && x.dp && x.pp) as {
    disp: number;
    st: Float64Array;
    dp: Float64Array;
    pp: Float64Array;
  }[];

  const priorNoise = NOISE_PRIOR_FRAC * PIPE_RUN_OFFSET_PSI;
  let sumP = 0;
  let sumD = 0;
  let cnt = 0;
  let sq = NOISE_PRIOR_WEIGHT * priorNoise * priorNoise;
  let sqN = NOISE_PRIOR_WEIGHT;
  const bufP: number[] = [];
  const bufD: number[] = [];

  for (let i = 0; i < n; i++) {
    bufP.length = 0;
    bufD.length = 0;
    for (const f of facs) {
      const st = f.st[i];
      const p = f.pp[i] - f.disp;
      const d = f.dp[i] - f.disp;
      if (!Number.isFinite(p) || !Number.isFinite(d)) continue;
      if (st === PUMP_RUNNING) {
        bufP.push(p);
        bufD.push(d);
      } else if (st === 0 || st === PUMP_FAULT) {
        sq += p * p + d * d;
        sqN += 2;
      }
    }
    if (bufP.length >= MIN_PEERS) {
      sumP += median(bufP);
      sumD += median(bufD);
      cnt++;
    }
    // documented offsets until the data has spoken (not used for scoring until ready)
    pipeOffset[i] = cnt ? sumP / cnt : PIPE_RUN_OFFSET_PSI;
    dischargeOffset[i] = cnt ? sumD / cnt : DISCHARGE_RUN_OFFSET_PSI;
    pressureNoise[i] = Math.sqrt(sq / sqN);
    ready[i] = cnt >= MIN_MEDIANS ? 1 : 0;
  }
  return { pipeOffset, dischargeOffset, pressureNoise, ready };
}

function median(xs: number[]): number {
  xs.sort((a, b) => a - b);
  const m = xs.length >> 1;
  return xs.length % 2 ? xs[m] : (xs[m - 1] + xs[m]) / 2;
}
