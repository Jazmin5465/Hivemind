// Plain-English evidence strings, computed from the readings (never canned numbers).
import type { Facility } from '../model';
import { tsAt, type Grid } from '../telemetry';
import {
  DISCHARGE_NOISE_PSI,
  DISCHARGE_RUN_OFFSET_PSI,
  EVIDENCE_WINDOW_STEPS,
  FLOW_NOISE,
  PIPE_P_NOISE_PSI,
  PIPE_RUN_OFFSET_PSI,
  PUMP_FAULT,
  PUMP_RUNNING,
  RECV_NOISE,
} from './constants';

export interface FacilitySeries {
  fac: Facility;
  disposalPsi: number;
  status: Float64Array;
  flow: Float64Array;
  discharge: Float64Array;
  recv: Float64Array;
  pipeP: Float64Array;
  level: Float64Array;
  inflow: Float64Array;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function fmtTime(unix: number): string {
  const d = new Date(unix * 1000);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()} ${hh}:${mm} UTC`;
}
const pct = (x: number, digits = 1) => `${(x * 100).toFixed(digits)}%`;
const psi = (x: number) => `${Math.round(x)} psi`;
const fmtInt = (x: number) => Math.round(x).toLocaleString('en-US');
function fmtDuration(steps: number, stepSec: number): string {
  const min = steps * stepSec / 60;
  if (min < 90) return `${Math.round(min)} min`;
  return `${(min / 60).toFixed(1)} h`;
}

/** Indices of the last `max` running steps in [from, to] (oldest first). */
function lastRunningSteps(s: FacilitySeries, from: number, to: number, max: number): number[] {
  const idx: number[] = [];
  for (let i = to; i >= from && idx.length < max; i--) if (s.status[i] === PUMP_RUNNING) idx.push(i);
  return idx.reverse();
}
/** Indices of the first `max` running steps in [from, to]. */
function firstRunningSteps(s: FacilitySeries, from: number, to: number, max: number): number[] {
  const idx: number[] = [];
  for (let i = from; i <= to && idx.length < max; i++) if (s.status[i] === PUMP_RUNNING) idx.push(i);
  return idx;
}
function meanOver(idx: number[], f: (i: number) => number): number {
  let t = 0;
  let n = 0;
  for (const i of idx) {
    const v = f(i);
    if (Number.isFinite(v)) {
      t += v;
      n++;
    }
  }
  return n ? t / n : NaN;
}

export function describeFailure(s: FacilitySeries, grid: Grid, onset: number, end: number | null, last: number): string[] {
  const ev: string[] = [];
  const stepSec = grid.stepSec;
  if (end === null) {
    ev.push(`Pump reporting a fault since ${fmtTime(tsAt(grid, onset))} (${fmtDuration(last - onset + 1, stepSec)})`);
    const l0 = s.level[Math.max(0, onset - 1)];
    const l1 = s.level[last];
    if (Number.isFinite(l0) && Number.isFinite(l1)) {
      const shutIn = s.inflow[last] === 0;
      ev.push(
        shutIn
          ? `Tank ${s.fac.tankId} has risen from ${l0.toFixed(1)}% to ${l1.toFixed(1)}% and the wells are shut in`
          : `Tank ${s.fac.tankId} level rising with no pumping: ${l0.toFixed(1)}% to ${l1.toFixed(1)}%`,
      );
    }
  } else {
    ev.push(
      `Pump reported a fault from ${fmtTime(tsAt(grid, onset))} to ${fmtTime(tsAt(grid, end))} (${fmtDuration(end - onset, stepSec)})`,
    );
    let peak = -Infinity;
    for (let i = onset; i < end; i++) if (s.level[i] > peak) peak = s.level[i];
    if (Number.isFinite(peak)) ev.push(`Tank ${s.fac.tankId} peaked at ${peak.toFixed(1)}% while the pump was down`);
  }
  // Flow during fault (should be ~0) confirms the status code.
  const to = end === null ? last : end - 1;
  let fsum = 0;
  let fn = 0;
  for (let i = onset; i <= to; i++) {
    if (s.status[i] === PUMP_FAULT && Number.isFinite(s.flow[i])) {
      fsum += s.flow[i];
      fn++;
    }
  }
  if (fn) ev.push(`Pump flow averaged ${fmtInt(fsum / fn)} bpd during the fault (rated ${fmtInt(s.fac.maxFlowBpd)} bpd)`);
  return ev.slice(0, 3);
}

export function describeLeak(s: FacilitySeries, grid: Grid, onset: number, ref: number): { evidence: string[]; score: number } {
  const idx = lastRunningSteps(s, onset, ref, 2 * EVIDENCE_WINDOW_STEPS);
  const ratio = meanOver(idx, (i) => s.recv[i] / s.flow[i]);
  const expected = s.disposalPsi + PIPE_RUN_OFFSET_PSI;
  const pDef = meanOver(idx, (i) => expected - s.pipeP[i]);
  const flowFrac = meanOver(idx, (i) => s.flow[i] / s.fac.maxFlowBpd);
  const span = fmtDuration(idx.length, grid.stepSec);
  const ev: string[] = [];
  if (idx.length === 0) return { evidence: ['Leak signature seen while pumping; pump is not running now'], score: 0 };
  ev.push(`Water reaching the disposal site is ${pct(ratio)} of what the pump sends (last ${span} of pumping)`);
  ev.push(`Pipeline pressure ${psi(pDef)} below normal while pumping (${fmtInt(expected - pDef)} vs ${fmtInt(expected)} psi expected)`);
  ev.push(`Pump output is normal (${pct(flowFrac)} of rated), so water is being lost between pump and disposal`);
  const score = ((1 - ratio) / RECV_NOISE + pDef / PIPE_P_NOISE_PSI) / Math.SQRT2;
  return { evidence: ev, score };
}

export function describeDegradation(s: FacilitySeries, grid: Grid, onset: number, ref: number): { evidence: string[]; score: number } {
  const idx = lastRunningSteps(s, onset, ref, EVIDENCE_WINDOW_STEPS);
  if (idx.length === 0) return { evidence: ['Pump output below rated flow while pumping'], score: 0 };
  const flowFrac = meanOver(idx, (i) => s.flow[i] / s.fac.maxFlowBpd);
  const expected = s.disposalPsi + DISCHARGE_RUN_OFFSET_PSI;
  const dDef = meanOver(idx, (i) => expected - s.discharge[i]);
  const span = fmtDuration(idx.length, grid.stepSec);
  const ev: string[] = [];
  ev.push(
    `Pump moving ${pct(flowFrac)} of its rated ${fmtInt(s.fac.maxFlowBpd)} bpd while running (last ${span} of pumping)`,
  );
  ev.push(`Discharge pressure ${psi(dDef)} below normal (${fmtInt(expected - dDef)} vs ${fmtInt(expected)} psi expected)`);
  const first = firstRunningSteps(s, onset, ref, EVIDENCE_WINDOW_STEPS);
  const flow0 = meanOver(first, (i) => s.flow[i] / s.fac.maxFlowBpd);
  const hours = (tsAt(grid, idx[idx.length - 1]) - tsAt(grid, first[0])) / 3600;
  if (hours >= 2 && flow0 - flowFrac > 0) {
    ev.push(`Output has slid from ${pct(flow0)} to ${pct(flowFrac)} of rated over ${hours.toFixed(1)} h, with no fault reported`);
  } else {
    ev.push('No fault reported and the pipeline receives what the pump sends, so the pump itself is weakening');
  }
  const score = ((1 - flowFrac) / FLOW_NOISE + dDef / DISCHARGE_NOISE_PSI) / Math.SQRT2;
  return { evidence: ev, score };
}
