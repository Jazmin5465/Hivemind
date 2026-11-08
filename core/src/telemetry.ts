// Telemetry on a regular time grid. One Float64Array per (assetId, metric), NaN = missing.
// "Now" is always the last ts_unix in the data, never the system clock.

export interface Grid {
  t0: number; // first ts_unix
  stepSec: number;
  n: number; // number of steps
  series: Map<string, Float64Array>; // key = seriesKey(assetId, metric)
}

export const seriesKey = (assetId: string, metric: string) => `${assetId}|${metric}`;
export function splitSeriesKey(k: string): [string, string] {
  const i = k.lastIndexOf('|');
  return [k.slice(0, i), k.slice(i + 1)];
}

export function gridGet(g: Grid, assetId: string, metric: string): Float64Array | undefined {
  return g.series.get(seriesKey(assetId, metric));
}
export const tsAt = (g: Grid, i: number) => g.t0 + i * g.stepSec;
export const tEnd = (g: Grid) => g.t0 + (g.n - 1) * g.stepSec;
/** Index of the last step with ts <= unix (clamped to [-1, n-1]). */
export function idxAtOrBefore(g: Grid, unix: number): number {
  const i = Math.floor((unix - g.t0) / g.stepSec);
  return Math.max(-1, Math.min(g.n - 1, i));
}

export class TelemetryError extends Error {}

const EXPECTED_HEADER = ['timestamp', 'ts_unix', 'asset_id', 'metric', 'value'];

/**
 * Parse telemetry.csv text into a Grid. Validates header, numeric values, and a
 * regular step. The step is inferred from the data (smallest positive gap).
 */
export function parseTelemetryCsv(text: string): Grid & { rowCount: number } {
  let pos = 0;
  const len = text.length;
  const nextLine = (): string | null => {
    if (pos >= len) return null;
    let e = text.indexOf('\n', pos);
    if (e < 0) e = len;
    let line = text.slice(pos, e);
    pos = e + 1;
    if (line.endsWith('\r')) line = line.slice(0, -1);
    return line;
  };
  const header = nextLine();
  if (header == null) throw new TelemetryError('telemetry.csv is empty');
  const cols = header.split(',').map((c) => c.trim());
  const idx = EXPECTED_HEADER.map((c) => cols.indexOf(c));
  const [, iTs, iAsset, iMetric, iValue] = idx;
  if (iTs < 0 || iAsset < 0 || iMetric < 0 || iValue < 0)
    throw new TelemetryError(`telemetry.csv header must contain ts_unix, asset_id, metric, value; got: ${header}`);

  // First pass: collect rows compactly.
  const tsArr: number[] = [];
  const keyArr: number[] = [];
  const valArr: number[] = [];
  const keyIds = new Map<string, number>();
  const keys: string[] = [];
  let line: string | null;
  let lineNo = 1;
  let tMin = Infinity;
  let tMax = -Infinity;
  while ((line = nextLine()) !== null) {
    lineNo++;
    if (line.length === 0) continue;
    const parts = line.split(',');
    const ts = Number(parts[iTs]);
    const v = parts[iValue] === undefined || parts[iValue] === '' ? NaN : Number(parts[iValue]);
    if (!Number.isFinite(ts)) throw new TelemetryError(`telemetry.csv line ${lineNo}: bad ts_unix`);
    const k = seriesKey(parts[iAsset], parts[iMetric]);
    let kid = keyIds.get(k);
    if (kid === undefined) {
      kid = keys.length;
      keys.push(k);
      keyIds.set(k, kid);
    }
    tsArr.push(ts);
    keyArr.push(kid);
    valArr.push(v);
    if (ts < tMin) tMin = ts;
    if (ts > tMax) tMax = ts;
  }
  if (tsArr.length === 0) throw new TelemetryError('telemetry.csv has no data rows');

  // Infer step: smallest positive difference between distinct sorted timestamps.
  const distinct = Array.from(new Set(tsArr)).sort((a, b) => a - b);
  let step = Infinity;
  for (let i = 1; i < distinct.length; i++) step = Math.min(step, distinct[i] - distinct[i - 1]);
  if (!Number.isFinite(step)) step = 300; // single timestamp: assume the documented 5-minute grid
  const n = Math.round((tMax - tMin) / step) + 1;

  const series = new Map<string, Float64Array>();
  const arrs: Float64Array[] = keys.map((k) => {
    const a = new Float64Array(n).fill(NaN);
    series.set(k, a);
    return a;
  });
  for (let r = 0; r < tsArr.length; r++) {
    const i = Math.round((tsArr[r] - tMin) / step);
    arrs[keyArr[r]][i] = valArr[r];
  }
  return { t0: tMin, stepSec: step, n, series, rowCount: tsArr.length };
}

/** A causal view: same grid truncated to steps with ts <= asOfUnix. */
export function truncateGrid(g: Grid, asOfUnix: number): Grid {
  const last = idxAtOrBefore(g, asOfUnix);
  const n = last + 1;
  const series = new Map<string, Float64Array>();
  for (const [k, a] of g.series) series.set(k, a.slice(0, n));
  return { t0: g.t0, stepSec: g.stepSec, n, series };
}
