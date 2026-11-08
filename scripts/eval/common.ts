import { countdownAt } from '../../core/src/countdown';
// Shared helpers for the eval harness.
import type { DatasetModel } from '../../core/src/model';
import { gridGet, idxAtOrBefore, tsAt, type Grid } from '../../core/src/telemetry';

export type Attempt<T> = { ok: true; value: T } | { ok: false; error: string; notImplemented: boolean };

/** Run fn; stubs that throw "not implemented" become {ok:false, notImplemented:true}. */
export function attempt<T>(fn: () => T): Attempt<T> {
  try {
    return { ok: true, value: fn() };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg, notImplemented: /not implemented/i.test(msg) };
  }
}

export const naText = (a: { ok: false; error: string; notImplemented: boolean }) =>
  a.notImplemented ? 'N/A (not implemented)' : `ERR: ${a.error.slice(0, 80)}`;

/** One scored check. pass === null means not evaluable (N/A). */
export interface Check {
  folder: string;
  section: string;
  name: string;
  pass: boolean | null;
  detail?: string;
  /** cheaper than reference: pass, but worth a manual look */
  flag?: string;
}

export class Checks {
  list: Check[] = [];
  add(c: Check): Check {
    this.list.push(c);
    return c;
  }
}

export const mark = (pass: boolean | null | undefined) => (pass == null ? '–' : pass ? '✓' : '✗');

/** Last non-NaN tank level at or before t (telemetry, causal). */
export function tankLevelAt(model: DatasetModel, grid: Grid, facilityId: string, t: number): number | null {
  const f = model.facilityById.get(facilityId);
  if (!f) return null;
  const s = gridGet(grid, f.tankId, 'level_pct');
  if (!s) return null;
  for (let i = idxAtOrBefore(grid, t); i >= 0; i--) if (!Number.isNaN(s[i])) return s[i];
  return null;
}

/** Level the app would plan from: countdownAt's de-noised estimate, else the raw reading. */
export function plannedLevelAt(model: DatasetModel, grid: Grid, facilityId: string, t: number, onsetUnix: number): number | null {
  try {
    const v = countdownAt(model, grid, facilityId, t, { sinceUnix: onsetUnix }).levelPct;
    if (Number.isFinite(v)) return v;
  } catch {
    /* countdown not available */
  }
  return tankLevelAt(model, grid, facilityId, t);
}

export const gridNow = (g: Grid) => tsAt(g, g.n - 1);

export function fmtTime(unix: number | null | undefined): string {
  if (unix == null) return '-';
  const d = new Date(unix * 1000).toISOString();
  return `${d.slice(5, 10)} ${d.slice(11, 16)}`;
}
export const fmtUsd = (v: number | null | undefined) => (v == null ? '-' : `$${Math.round(v).toLocaleString('en-US')}`);
export const fmtNum = (v: number | null | undefined, d = 1) => (v == null || !Number.isFinite(v) ? '-' : v.toFixed(d));
export function fmtMin(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec)) return '-';
  const m = Math.round(sec / 60);
  return Math.abs(m) >= 120 ? `${(m / 60).toFixed(1)}h` : `${m}m`;
}
export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const k = s.length >> 1;
  return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2;
}
export const pad = (s: string, n: number) => (s.length >= n ? s : s + ' '.repeat(n - s.length));
export const lpad = (s: string, n: number) => (s.length >= n ? s : ' '.repeat(n - s.length) + s);
