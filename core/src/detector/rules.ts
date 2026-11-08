// Rules-based detector (fallback when the ML sidecar is down; baseline for Hadent).
// CONTRACT:
//  - Pure, causal: reads only grid indices whose ts <= asOfUnix.
//  - Prefix-consistent: once an event is emitted, its onsetUnix never changes as asOfUnix grows.
//  - No hardcoded IDs / thresholds tied to one network: normalise by network.json specs.
//
// How it works: one forward pass per facility over steps 0..asOf. Every decision at step i
// uses data <= i only, so running to asOf T gives exactly the events a full run had
// confirmed by T (same onsets), and a physically truncated grid gives the same answer.
//
//  pump_failure      pump status == 2 (fault). Onset = first fault step, end = first step after.
//  pipeline_leak     while pumping: receive flow < pump flow AND pipeline pressure below
//                    disposal + run offset. CUSUM on a combined z-score, frozen while the pump
//                    is off (a leak is invisible then), so a leak survives pump-off periods.
//  pump_degradation  while pumping: flow below max_flow_bpd AND discharge pressure below
//                    disposal + run offset. Slow drift, so a low-reference CUSUM; ends at
//                    recovery or where a pump_failure starts.
// Pressure offsets and noise are calibrated causally from peer pumps (calibrate.ts); flows
// are normalised by each pump's max_flow_bpd and by the pump's own output.
import type { DatasetModel, Facility } from '../model';
import { gridGet, idxAtOrBefore, tsAt, type Grid } from '../telemetry';
import type { DetectedEvent, EventCategory } from '../types';
import {
  DEG,
  LEAK,
  PUMP_FAULT,
  PUMP_RUNNING,
  RECV_NOISE,
  FLOW_NOISE,
} from './constants';
import { calibrate, type Calibration } from './calibrate';
import { Cusum } from './cusum';
import { describeDegradation, describeFailure, describeLeak, type FacilitySeries } from './evidence';

export interface RulesOptions {
  /** defaults to the last ts in the grid ("now") */
  asOfUnix?: number;
}

/** Internal event record; indices are grid steps. */
interface RawEvent {
  category: EventCategory;
  facility: Facility;
  assetId: string;
  onsetIdx: number;
  /** step at which the detector became sure (emission time) */
  detectIdx: number;
  /** first step no longer in the event; null while ongoing */
  endIdx: number | null;
  /** largest per-event score seen up to asOf (drives confidence) */
  peakScore: number;
}

export function detectRules(model: DatasetModel, grid: Grid, opts: RulesOptions = {}): DetectedEvent[] {
  const asOf = opts.asOfUnix ?? tsAt(grid, grid.n - 1);
  const last = idxAtOrBefore(grid, asOf);
  if (last < 0) return [];
  const out: DetectedEvent[] = [];
  const cal = calibrate(model, grid, last);
  for (const fac of model.facilities) {
    const s = loadSeries(model, grid, fac, cal);
    if (!s) continue;
    const raws = scanFacility(s, last);
    for (const r of raws) out.push(toEvent(r, s, grid, last));
  }
  out.sort((a, b) => a.onsetUnix - b.onsetUnix || a.assetId.localeCompare(b.assetId) || a.category.localeCompare(b.category));
  return out;
}

function loadSeries(model: DatasetModel, grid: Grid, fac: Facility, cal: Calibration): FacilitySeries | null {
  const sys = model.systemById.get(fac.systemId);
  const status = gridGet(grid, fac.pumpId, 'status');
  const flow = gridGet(grid, fac.pumpId, 'flow_bpd');
  const discharge = gridGet(grid, fac.pumpId, 'discharge_psi');
  const recv = gridGet(grid, fac.pipelineId, 'receive_flow_bpd');
  const pipeP = gridGet(grid, fac.pipelineId, 'pressure_psi');
  if (!sys || !status) return null;
  const nan = new Float64Array(grid.n).fill(NaN);
  return {
    fac,
    cal,
    disposalPsi: sys.disposalPressurePsi,
    status,
    flow: flow ?? nan,
    discharge: discharge ?? nan,
    recv: recv ?? nan,
    pipeP: pipeP ?? nan,
    level: gridGet(grid, fac.tankId, 'level_pct') ?? nan,
    inflow: gridGet(grid, fac.id, 'inflow_bpd') ?? nan,
  };
}

/** Per-step leak z-score (positive = leak-like), or NaN if not computable. */
export function leakZ(s: FacilitySeries, i: number): { zP: number; zR: number } {
  if (!s.cal.ready[i]) return { zP: NaN, zR: NaN }; // still calibrating pressure offsets
  const f = s.flow[i];
  const zR = f > 0 ? (1 - s.recv[i] / f) / RECV_NOISE : NaN;
  const zP = (s.disposalPsi + s.cal.pipeOffset[i] - s.pipeP[i]) / s.cal.pressureNoise[i];
  return { zP, zR };
}

/** Per-step degradation z-score (positive = worn-pump-like), or NaN if not computable. */
export function degZ(s: FacilitySeries, i: number): { zF: number; zD: number } {
  if (!s.cal.ready[i]) return { zF: NaN, zD: NaN }; // still calibrating pressure offsets
  const zF = (1 - s.flow[i] / s.fac.maxFlowBpd) / FLOW_NOISE;
  const zD = (s.disposalPsi + s.cal.dischargeOffset[i] - s.discharge[i]) / s.cal.pressureNoise[i];
  return { zF, zD };
}

/**
 * Forward pass over steps 0..last. Each emitted event's onset is fixed at its detectIdx;
 * end is set at the step where the recovery is confirmed (backdated to recovery start).
 */
function scanFacility(s: FacilitySeries, last: number): RawEvent[] {
  const events: RawEvent[] = [];
  const fac = s.fac;

  let failure: RawEvent | null = null;
  let prevRunning = false;

  // Leak state
  const leakUp = new Cusum(LEAK.K, LEAK.ONSET_LEVEL);
  const leakDown = new Cusum(0, 0); // fed (K_END - z): grows on healthy steps
  let leak: RawEvent | null = null;
  const leakWin = new RunningWindow(LEAK.CONFIRM_WINDOW_STEPS);

  // Degradation state
  const degUp = new Cusum(DEG.K, Infinity);
  const degDown = new Cusum(0, 0); // fed (K_END - z): grows on healthy steps
  let deg: RawEvent | null = null;
  const degWin = new RunningWindow(DEG.CONFIRM_WINDOW_STEPS);

  for (let i = 0; i <= last; i++) {
    const st = s.status[i];
    if (Number.isNaN(st)) continue; // missing reading: no information, keep state

    // ---- pump_failure: direct status reading -------------------------------------------
    if (st === PUMP_FAULT) {
      if (!failure) {
        failure = { category: 'pump_failure', facility: fac, assetId: fac.pumpId, onsetIdx: i, detectIdx: i, endIdx: null, peakScore: 1 };
        events.push(failure);
        // A worn pump that then fails is two events: degradation ends where failure begins.
        if (deg) {
          deg.endIdx = i;
          deg = null;
        }
        degUp.reset();
        degDown.reset();
        degWin.clear();
      }
      continue; // nothing else is observable while in fault; leak state is carried
    }
    if (failure) {
      failure.endIdx = i;
      failure = null;
    }
    if (st !== PUMP_RUNNING) {
      prevRunning = false;
      continue; // pump off: leaks/wear invisible, carry state
    }

    // ---- pipeline_leak ------------------------------------------------------------------
    const { zP, zR } = leakZ(s, i);
    if (Number.isFinite(zP) && Number.isFinite(zR)) {
      // Combined evidence; each term is clipped so one wild reading can't carry an alarm alone.
      const z = (clip(zP, LEAK.Z_CLIP) + clip(zR, LEAK.Z_CLIP)) / Math.SQRT2;
      leakWin.push(zP, zR);
      if (!leak) {
        leakUp.update(z, i);
        if (leakUp.s >= LEAK.H && leakWin.meanA() >= LEAK.MIN_MEAN_Z_EACH && leakWin.meanB() >= LEAK.MIN_MEAN_Z_EACH) {
          leak = {
            category: 'pipeline_leak',
            facility: fac,
            assetId: fac.pipelineId,
            onsetIdx: leakUp.onsetIdx ?? i,
            detectIdx: i,
            endIdx: null,
            peakScore: leakWin.meanCombined(),
          };
          events.push(leak);
          leakDown.reset();
        }
      } else {
        leak.peakScore = Math.max(leak.peakScore, leakWin.meanCombined());
        // Recovery CUSUM: grows while readings look healthy (z well below the reference).
        leakDown.update(LEAK.K_END - z, i);
        if (leakDown.s >= LEAK.H_END) {
          leak.endIdx = leakDown.startIdx ?? i;
          leak = null;
          leakUp.reset();
          leakWin.clear();
        }
      }
    }

    // ---- pump_degradation ---------------------------------------------------------------
    const { zF, zD } = degZ(s, i);
    if (Number.isFinite(zF) && Number.isFinite(zD)) {
      const z = (clip(zF, DEG.Z_CLIP) + clip(zD, DEG.Z_CLIP)) / Math.SQRT2;
      degWin.push(zF, zD);
      if (!deg) {
        // A small noise excursion shouldn't be carried across a pump-off gap: re-arm.
        if (!prevRunning && degUp.s < DEG.CARRY_MIN) degUp.reset();
        degUp.update(z, i);
        if (degUp.s >= DEG.H && degWin.meanA() >= DEG.MIN_MEAN_Z_FLOW && degWin.full()) {
          deg = {
            category: 'pump_degradation',
            facility: fac,
            assetId: fac.pumpId,
            onsetIdx: estimateRampOnset(s, degUp.startIdx ?? i, i),
            detectIdx: i,
            endIdx: null,
            peakScore: degWin.meanCombined(),
          };
          events.push(deg);
          degDown.reset();
        }
      } else {
        deg.peakScore = Math.max(deg.peakScore, degWin.meanCombined());
        degDown.update(DEG.K_END - z, i);
        if (degDown.s >= DEG.H_END) {
          deg.endIdx = degDown.startIdx ?? i;
          deg = null;
          degUp.reset();
          degWin.clear();
        }
      }
    }
    prevRunning = true;
  }
  return events;
}

/**
 * Degradation is a ramp that starts at zero, so the CUSUM start lags the true onset.
 * Fit a line to the combined z of running steps [start, detect] and take its zero crossing,
 * bounded below by the last running step before the excursion (the pump looked healthy then)
 * and above by the CUSUM start. Uses only data <= detect.
 */
function estimateRampOnset(s: FacilitySeries, start: number, detect: number): number {
  let lo = 0;
  for (let j = start - 1; j >= 0; j--) {
    if (s.status[j] === PUMP_RUNNING) {
      lo = j + 1;
      break;
    }
  }
  let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let j = start; j <= detect; j++) {
    if (s.status[j] !== PUMP_RUNNING) continue;
    const { zF, zD } = degZ(s, j);
    if (!Number.isFinite(zF) || !Number.isFinite(zD)) continue;
    const y = (clip(zF, DEG.Z_CLIP) + clip(zD, DEG.Z_CLIP)) / Math.SQRT2;
    n++;
    sx += j;
    sy += y;
    sxx += j * j;
    sxy += j * y;
  }
  const den = n * sxx - sx * sx;
  if (n < 3 || den <= 0) return start;
  const slope = (n * sxy - sx * sy) / den;
  if (slope <= 0) return start;
  const x0 = sx / n - sy / n / slope;
  return Math.max(lo, Math.min(start, Math.round(x0)));
}

function clip(x: number, c: number) {
  return x > c ? c : x < -c ? -c : x;
}

/** Last N running-step values of two z components (a, b), for confirmation and evidence. */
export class RunningWindow {
  private a: number[] = [];
  private b: number[] = [];
  constructor(private readonly size: number) {}
  push(za: number, zb: number) {
    this.a.push(za);
    this.b.push(zb);
    if (this.a.length > this.size) {
      this.a.shift();
      this.b.shift();
    }
  }
  clear() {
    this.a = [];
    this.b = [];
  }
  full() {
    return this.a.length >= this.size;
  }
  meanA() {
    return mean(this.a);
  }
  meanB() {
    return mean(this.b);
  }
  meanCombined() {
    return (this.meanA() + this.meanB()) / Math.SQRT2;
  }
}

function mean(xs: number[]) {
  if (xs.length === 0) return 0;
  let t = 0;
  for (const x of xs) t += x;
  return t / xs.length;
}

/** Map an evidence score (mean combined z) to 0..1. Saturating, so confidence grows with evidence. */
function confidenceOf(r: RawEvent, scoreNow: number): number {
  if (r.category === 'pump_failure') return 0.99;
  const score = Math.max(scoreNow, 0);
  const p = r.category === 'pipeline_leak' ? LEAK : DEG;
  const c = 1 - Math.exp(-score / p.CONF_SCALE);
  return round2(Math.min(p.CONF_MAX, Math.max(p.CONF_MIN, c)));
}

function round2(x: number) {
  return Math.round(x * 100) / 100;
}

function toEvent(r: RawEvent, s: FacilitySeries, grid: Grid, last: number): DetectedEvent {
  const ended = r.endIdx !== null && r.endIdx <= last;
  // Evidence describes the event up to its end (resolved) or up to now (ongoing).
  const refIdx = ended ? (r.endIdx as number) - 1 : last;
  let evidence: string[];
  let score = r.peakScore;
  if (r.category === 'pump_failure') {
    evidence = describeFailure(s, grid, r.onsetIdx, ended ? r.endIdx : null, last);
  } else if (r.category === 'pipeline_leak') {
    const d = describeLeak(s, grid, r.onsetIdx, refIdx);
    evidence = d.evidence;
    if (!ended) score = Math.max(d.score, 0);
  } else {
    const d = describeDegradation(s, grid, r.onsetIdx, refIdx);
    evidence = d.evidence;
    if (!ended) score = Math.max(d.score, 0);
  }
  return {
    category: r.category,
    systemId: r.facility.systemId,
    facilityId: r.facility.id,
    assetId: r.assetId,
    onsetUnix: tsAt(grid, r.onsetIdx),
    endUnix: ended ? tsAt(grid, r.endIdx as number) : null,
    status: ended ? 'resolved' : 'ongoing',
    confidence: confidenceOf(r, score),
    source: 'rules',
    evidence,
  };
}
