// Turn the ML sidecar's per-step class probabilities (stored as extra series) into events.
// Causal hysteresis: an event opens when P(class) > openThreshold for minOpenSteps consecutive
// steps (onset = first step of that run, fixed once opened) and closes when P(class) drops
// below closeThreshold for minCloseSteps consecutive steps (end = first step of that run).
import type { DatasetModel } from './model';
import { gridGet, idxAtOrBefore, tsAt, type Grid } from './telemetry';
import type { DetectedEvent, EventCategory } from './types';

export const ML_METRICS = {
  failure: 'ml_p_failure',
  degradation: 'ml_p_degradation',
  leak: 'ml_p_leak',
} as const;

export interface MlEventOptions {
  asOfUnix?: number;
  openThreshold?: number;
  closeThreshold?: number;
  minOpenSteps?: number;
  minCloseSteps?: number;
  modelVersion?: string;
}

interface Target {
  assetId: string;
  facilityId: string;
  systemId: string;
  metric: string;
  category: EventCategory;
}

export function mlTargets(model: DatasetModel): Target[] {
  const out: Target[] = [];
  for (const f of model.facilities) {
    out.push({ assetId: f.pumpId, facilityId: f.id, systemId: f.systemId, metric: ML_METRICS.failure, category: 'pump_failure' });
    out.push({ assetId: f.pumpId, facilityId: f.id, systemId: f.systemId, metric: ML_METRICS.degradation, category: 'pump_degradation' });
    out.push({ assetId: f.pipelineId, facilityId: f.id, systemId: f.systemId, metric: ML_METRICS.leak, category: 'pipeline_leak' });
  }
  return out;
}

/** true if the grid holds ML probabilities for at least one asset */
export function hasMlSeries(model: DatasetModel, grid: Grid): boolean {
  return mlTargets(model).some((t) => gridGet(grid, t.assetId, t.metric) !== undefined);
}

/** last index with a finite ML probability (ML coverage ends where the sidecar's asOf ended) */
export function mlCoverageEndIdx(model: DatasetModel, grid: Grid): number {
  let end = -1;
  for (const t of mlTargets(model)) {
    const a = gridGet(grid, t.assetId, t.metric);
    if (!a) continue;
    for (let i = a.length - 1; i > end; i--) if (Number.isFinite(a[i])) { end = i; break; }
  }
  return end;
}

export function detectFromMl(model: DatasetModel, grid: Grid, opts: MlEventOptions = {}): DetectedEvent[] {
  const asOf = opts.asOfUnix ?? tsAt(grid, grid.n - 1);
  const last = idxAtOrBefore(grid, asOf);
  const open = opts.openThreshold ?? 0.5;
  const close = opts.closeThreshold ?? 0.5;
  const minOpen = opts.minOpenSteps ?? 3;
  const minClose = opts.minCloseSteps ?? 3;
  const label = opts.modelVersion ? ` (${opts.modelVersion})` : '';
  const events: DetectedEvent[] = [];

  for (const tg of mlTargets(model)) {
    const p = gridGet(grid, tg.assetId, tg.metric);
    if (!p) continue;
    let state: 'idle' | 'open' = 'idle';
    let runStart = -1;
    let run = 0;
    let cur: DetectedEvent | null = null;
    let peak = 0;
    for (let i = 0; i <= last; i++) {
      const v = p[i];
      if (!Number.isFinite(v)) continue;
      if (state === 'idle') {
        if (v > open) {
          if (run === 0) runStart = i;
          run++;
          if (run >= minOpen) {
            state = 'open';
            peak = v;
            cur = {
              category: tg.category,
              systemId: tg.systemId,
              facilityId: tg.facilityId,
              assetId: tg.assetId,
              onsetUnix: tsAt(grid, runStart),
              endUnix: null,
              status: 'ongoing',
              confidence: v,
              source: 'ml',
              evidence: [],
            };
            run = 0;
          }
        } else run = 0;
      } else if (cur) {
        peak = Math.max(peak, v);
        if (v < close) {
          if (run === 0) runStart = i;
          run++;
          if (run >= minClose) {
            cur.endUnix = tsAt(grid, runStart);
            cur.status = 'resolved';
            cur.evidence = [`ML model${label}: P(${tg.category.replace('_', ' ')}) peaked at ${(peak * 100).toFixed(0)}%`];
            cur.confidence = peak;
            events.push(cur);
            cur = null;
            state = 'idle';
            run = 0;
          }
        } else {
          run = 0;
          cur.confidence = v;
        }
      }
    }
    if (cur) {
      cur.evidence = [`ML model${label}: P(${tg.category.replace('_', ' ')}) is ${(cur.confidence * 100).toFixed(0)}% now (peak ${(peak * 100).toFixed(0)}%)`];
      events.push(cur);
    }
  }
  events.sort((a, b) => a.onsetUnix - b.onsetUnix);
  return events;
}
