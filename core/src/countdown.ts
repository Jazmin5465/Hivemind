// Shutdown countdown for a failed pump. Physics (SPEC.md):
//   level change per hour = (inflow - pump flow) / 24 / capacity * 100
// p50 comes from the physics with the wells' baseline water rates (what the tank will see
// if nothing changes). p10/p90 come from noise in the recently observed level slope.
import type { DatasetModel } from './model';
import { gridGet, idxAtOrBefore, tsAt, type Grid } from './telemetry';

export interface Countdown {
  facilityId: string;
  asOfUnix: number;
  /** tank level at asOfUnix: noise-reduced estimate (fixed-slope fit since onset) when possible */
  levelPct: number;
  /** last raw level reading at or before asOfUnix */
  levelPctRaw: number;
  inflowBpd: number; // inflow used by the physics model
  ratePctPerHour: number;
  /** observed level slope over the recent window (pct/h), null if too few points */
  observedRatePctPerHour: number | null;
  /** null if the level is not rising */
  hoursToLimitP50: number | null;
  hoursToLimitP10: number | null;
  hoursToLimitP90: number | null;
  /** asOfUnix + p50 hours, null if not rising */
  tripsAtUnix: number | null;
  /** tank is already at shutdown (wells shut in) */
  alreadyTripped: boolean;
  /** wells producing at asOfUnix */
  producingWells: string[];
}

export interface CountdownOptions {
  /** only use level points at or after this time for the slope (e.g. the failure onset) */
  sinceUnix?: number;
  /** pump flow out of the tank; 0 for a failed pump */
  pumpFlowBpd?: number;
  /** max points in the slope window (default 12 = 1 h on a 5-min grid) */
  windowSteps?: number;
  /** max points used to de-noise the current level (default 36 = 3 h on a 5-min grid) */
  levelFitSteps?: number;
}

const Z90 = 1.2816; // standard normal 90th percentile
const MAX_REL_UNCERTAINTY = 0.5;

function lastFinite(a: Float64Array | undefined, i: number): number {
  if (!a) return NaN;
  for (let j = i; j >= 0; j--) if (Number.isFinite(a[j])) return a[j];
  return NaN;
}

export function countdownAt(
  model: DatasetModel,
  grid: Grid,
  facilityId: string,
  asOfUnix: number,
  opts: CountdownOptions = {},
): Countdown {
  const fac = model.facilityById.get(facilityId);
  if (!fac) throw new Error(`unknown facility ${facilityId}`);
  const idx = idxAtOrBefore(grid, asOfUnix);
  const levelRaw = lastFinite(gridGet(grid, fac.tankId, 'level_pct'), idx);
  const producing = fac.wells.filter((w) => {
    const st = lastFinite(gridGet(grid, w.id, 'status'), idx);
    return !Number.isFinite(st) || st >= 0.5;
  });
  const inflow = producing.reduce((a, w) => a + w.baselineWaterBpd, 0);
  const pumpFlow = opts.pumpFlowBpd ?? 0;
  const rate = ((inflow - pumpFlow) / 24 / fac.capacityBbl) * 100;
  const shutdown = model.shutdownPct;
  const alreadyTripped = Number.isFinite(levelRaw) && levelRaw >= shutdown - 0.05 && producing.length === 0;
  const level = alreadyTripped ? levelRaw : denoisedLevel(grid, fac.tankId, idx, asOfUnix, rate, opts, levelRaw);

  // observed slope (least squares) over the recent window
  const win = opts.windowSteps ?? 12;
  const lv = gridGet(grid, fac.tankId, 'level_pct');
  const xs: number[] = [];
  const ys: number[] = [];
  if (lv) {
    for (let j = idx; j >= 0 && xs.length < win; j--) {
      const t = tsAt(grid, j);
      if (opts.sinceUnix != null && t < opts.sinceUnix) break;
      if (!Number.isFinite(lv[j])) continue;
      xs.push((t - asOfUnix) / 3600);
      ys.push(lv[j]);
    }
  }
  let obsRate: number | null = null;
  let slopeSe = NaN;
  if (xs.length >= 3) {
    const n = xs.length;
    const mx = xs.reduce((a, b) => a + b, 0) / n;
    const my = ys.reduce((a, b) => a + b, 0) / n;
    let sxx = 0;
    let sxy = 0;
    for (let i = 0; i < n; i++) {
      sxx += (xs[i] - mx) ** 2;
      sxy += (xs[i] - mx) * (ys[i] - my);
    }
    if (sxx > 0) {
      obsRate = sxy / sxx;
      let sse = 0;
      for (let i = 0; i < n; i++) sse += (ys[i] - (my + obsRate * (xs[i] - mx))) ** 2;
      slopeSe = Math.sqrt(sse / Math.max(1, n - 2) / sxx);
    }
  }

  let p50: number | null = null;
  let p10: number | null = null;
  let p90: number | null = null;
  if (alreadyTripped) {
    p50 = p10 = p90 = 0;
  } else if (rate > 0 && Number.isFinite(level)) {
    const remaining = Math.max(0, shutdown - level);
    p50 = remaining / rate;
    // relative uncertainty of the rate: slope noise plus disagreement between observed and physics
    let u: number;
    if (obsRate !== null && Number.isFinite(slopeSe)) {
      u = Math.sqrt(slopeSe ** 2 + (obsRate - rate) ** 2) / rate;
    } else {
      u = 0.1; // too few points since onset: generic +/-10% band
    }
    u = Math.min(MAX_REL_UNCERTAINTY, u);
    p10 = remaining / (rate * (1 + Z90 * u));
    p90 = remaining / (rate * Math.max(1e-6, 1 - Z90 * u));
  }
  return {
    facilityId,
    asOfUnix,
    levelPct: level,
    levelPctRaw: levelRaw,
    inflowBpd: inflow,
    ratePctPerHour: rate,
    observedRatePctPerHour: obsRate,
    hoursToLimitP50: p50,
    hoursToLimitP10: p10,
    hoursToLimitP90: p90,
    tripsAtUnix: p50 === null ? null : asOfUnix + p50 * 3600,
    alreadyTripped,
    producingWells: producing.map((w) => w.id),
  };
}

/**
 * While a failed pump's tank fills, the level is a straight line with the physics slope plus
 * sensor noise. Estimate the current level as the intercept of that line through the points
 * since onset (slope fixed to the physics rate). Falls back to the raw reading if the onset is
 * unknown, there are too few points, or the points don't follow the line (wells changed).
 */
function denoisedLevel(
  grid: Grid,
  tankId: string,
  idx: number,
  asOfUnix: number,
  rate: number,
  opts: CountdownOptions,
  raw: number,
): number {
  if (opts.sinceUnix == null || !(rate > 0)) return raw;
  const lv = gridGet(grid, tankId, 'level_pct');
  if (!lv) return raw;
  const maxPts = opts.levelFitSteps ?? 36;
  const resid: number[] = [];
  for (let j = idx; j >= 0 && resid.length < maxPts; j--) {
    const t = tsAt(grid, j);
    if (t < opts.sinceUnix) break;
    if (!Number.isFinite(lv[j])) continue;
    resid.push(lv[j] - rate * ((t - asOfUnix) / 3600));
  }
  if (resid.length < 3) return preOnsetFit(lv, grid, idx, raw);
  const est = resid.reduce((a, b) => a + b, 0) / resid.length;
  const sd = Math.sqrt(resid.reduce((a, b) => a + (b - est) ** 2, 0) / (resid.length - 1));
  // points far off the line => physics assumption broken; trust the raw reading
  if (Math.abs(est - raw) > Math.max(1, 4 * sd)) return raw;
  return est;
}

/**
 * Right at a failure's onset there are no points since onset yet. Fit a free line through the
 * last few readings (the tank was on one straight segment of its sawtooth) and evaluate it at
 * idx. Rejected (raw reading used) if the points don't lie on one line, e.g. a pump switch.
 */
function preOnsetFit(lv: Float64Array, grid: Grid, idx: number, raw: number, k = 6): number {
  const xs: number[] = [];
  const ys: number[] = [];
  for (let j = idx; j >= 0 && xs.length < k; j--) {
    if (!Number.isFinite(lv[j])) continue;
    xs.push(j - idx);
    ys.push(lv[j]);
  }
  if (xs.length < 4) return raw;
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i] - mx) ** 2;
    sxy += (xs[i] - mx) * (ys[i] - my);
  }
  if (sxx === 0) return raw;
  const b = sxy / sxx;
  let sse = 0;
  for (let i = 0; i < n; i++) sse += (ys[i] - (my + b * (xs[i] - mx))) ** 2;
  const sd = Math.sqrt(sse / (n - 2));
  const est = my + b * (0 - mx);
  if (sd > 0.5 || Math.abs(est - raw) > Math.max(1, 4 * sd)) return raw;
  void grid;
  return est;
}
