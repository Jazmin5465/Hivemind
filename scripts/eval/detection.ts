// Detection scoring: match detector output to answer-key labels.
import type { DatasetModel } from '../../core/src/model';
import type { Grid } from '../../core/src/telemetry';
import type { DetectedEvent } from '../../core/src/types';
import { detectRules } from '../../core/src/detector/rules';
import type { AnswerKeyEvent } from './answerKey';
import { attempt, gridNow, median, type Attempt } from './common';

export interface MatchOptions {
  /** detected onset may precede the labelled onset by this much */
  tolSec: number;
}

/** Window in which a detected onset counts for a label: [onset − tol, end ?? now]. */
export function inWindow(label: AnswerKeyEvent, ev: DetectedEvent, nowUnix: number, o: MatchOptions): boolean {
  if (ev.category !== label.category || ev.assetId !== label.asset) return false;
  const hi = label.endUnix ?? nowUnix;
  return ev.onsetUnix >= label.onsetUnix - o.tolSec && ev.onsetUnix <= hi;
}

export interface LabelMatch {
  label: AnswerKeyEvent;
  detected: DetectedEvent | null;
  onsetDeltaSec: number | null;
  /** label status === detected status (null if not detected) */
  statusOk: boolean | null;
  /** first sweep asOf at which a matching event appeared */
  firstSeenUnix: number | null;
}

export interface Matching {
  matches: LabelMatch[];
  falseAlarms: DetectedEvent[];
  duplicates: DetectedEvent[];
}

/** Greedy one-to-one matching in label onset order, nearest onset first. */
export function matchEvents(labels: AnswerKeyEvent[], detected: DetectedEvent[], nowUnix: number, o: MatchOptions): Matching {
  const used = new Set<number>();
  const matches: LabelMatch[] = labels.map((label) => {
    let best = -1;
    let bestD = Infinity;
    detected.forEach((ev, i) => {
      if (used.has(i) || !inWindow(label, ev, nowUnix, o)) return;
      const d = Math.abs(ev.onsetUnix - label.onsetUnix);
      if (d < bestD) (best = i), (bestD = d);
    });
    if (best < 0) return { label, detected: null, onsetDeltaSec: null, statusOk: null, firstSeenUnix: null };
    used.add(best);
    const ev = detected[best];
    return { label, detected: ev, onsetDeltaSec: ev.onsetUnix - label.onsetUnix, statusOk: ev.status === label.status, firstSeenUnix: null };
  });
  const falseAlarms: DetectedEvent[] = [];
  const duplicates: DetectedEvent[] = [];
  detected.forEach((ev, i) => {
    if (used.has(i)) return;
    (labels.some((l) => inWindow(l, ev, nowUnix, o)) ? duplicates : falseAlarms).push(ev);
  });
  return { matches, falseAlarms, duplicates };
}

export interface CategoryScore {
  hits: number;
  total: number;
}

export interface DetectionScore {
  nowUnix: number;
  detected: DetectedEvent[];
  perCategory: Record<string, CategoryScore>;
  matching: Matching;
  ongoing: { hits: number; total: number };
  onsetDeltaMedianSec: number | null;
  onsetDeltaMaxAbsSec: number | null;
  latencyMedianSec: number | null;
  latencyMaxSec: number | null;
  sweep: { stepSec: number; calls: number; ms: number; error?: string } | null;
}

export function scoreDetection(
  model: DatasetModel,
  grid: Grid,
  labels: AnswerKeyEvent[],
  o: MatchOptions & { sweepStepSec: number; detect?: (asOfUnix: number) => DetectedEvent[] },
): Attempt<DetectionScore> {
  const nowUnix = gridNow(grid);
  const detect = o.detect ?? ((asOfUnix: number) => detectRules(model, grid, { asOfUnix }));
  const det = attempt(() => detect(nowUnix));
  if (!det.ok) return det;
  const detected = det.value;
  const matching = matchEvents(labels, detected, nowUnix, o);

  const perCategory: Record<string, CategoryScore> = {};
  for (const m of matching.matches) {
    const c = (perCategory[m.label.category] ??= { hits: 0, total: 0 });
    c.total++;
    if (m.detected) c.hits++;
  }
  const ongoingMs = matching.matches.filter((m) => m.label.status === 'ongoing');
  const ongoing = { hits: ongoingMs.filter((m) => m.detected?.status === 'ongoing').length, total: ongoingMs.length };

  let sweep: DetectionScore['sweep'] = null;
  if (o.sweepStepSec > 0) {
    const t0 = Date.now();
    let calls = 0;
    let error: string | undefined;
    const pending = new Set(matching.matches.map((_, i) => i));
    const startAt = grid.t0 + grid.stepSec;
    for (let asOf = startAt; asOf <= nowUnix && pending.size; asOf += o.sweepStepSec) {
      const relevant = [...pending].filter((i) => matching.matches[i].label.onsetUnix - o.tolSec <= asOf);
      if (!relevant.length) continue;
      const r = attempt(() => detect(asOf));
      calls++;
      if (!r.ok) {
        error = r.error;
        break;
      }
      for (const i of relevant) {
        if (r.value.some((ev) => inWindow(matching.matches[i].label, ev, asOf, o))) {
          matching.matches[i].firstSeenUnix = asOf;
          pending.delete(i);
        }
      }
    }
    // anything still pending but detected at "now" was first seen at now
    for (const i of pending) if (matching.matches[i].detected) matching.matches[i].firstSeenUnix = nowUnix;
    sweep = { stepSec: o.sweepStepSec, calls, ms: Date.now() - t0, error };
  }

  const deltas = matching.matches.map((m) => m.onsetDeltaSec).filter((x): x is number => x != null);
  const lat = matching.matches
    .filter((m) => m.firstSeenUnix != null)
    .map((m) => (m.firstSeenUnix as number) - m.label.onsetUnix);
  return {
    ok: true,
    value: {
      nowUnix,
      detected,
      perCategory,
      matching,
      ongoing,
      onsetDeltaMedianSec: median(deltas),
      onsetDeltaMaxAbsSec: deltas.length ? Math.max(...deltas.map(Math.abs)) : null,
      latencyMedianSec: median(lat),
      latencyMaxSec: lat.length ? Math.max(...lat) : null,
      sweep,
    },
  };
}
