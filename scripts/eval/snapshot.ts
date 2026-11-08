// Snapshot scoring ("planned from now"): countdown, alert order and joint plans for ongoing pump failures.
// Two modes:
//   oracle   - failures built from the labels' onsets (scores countdown/planner independently of the detector)
//   detected - failures from detectRules() at "now", mapped back to labels for comparison
import type { DatasetModel } from '../../core/src/model';
import type { Grid } from '../../core/src/telemetry';
import type { DetectedEvent, PlanAction } from '../../core/src/types';
import { countdownAt, type Countdown } from '../../core/src/countdown';
import { planSystem, type FailureInput, type SystemPlan } from '../../core/src/planner';
import { orderAlerts, type AlertItem } from '../../core/src/alerts';
import type { AnswerKeyEvent, ReferenceAction } from './answerKey';
import { attempt, gridNow, tankLevelAt, type Attempt } from './common';
import { matchEvents, type MatchOptions } from './detection';

export interface Tolerances {
  levelPct: number;
  hours: number;
  costUsd: number;
}

export interface CountdownRow {
  label: AnswerKeyEvent;
  countdown: Attempt<Countdown>;
  levelOk: boolean | null;
  hoursOk: boolean | null;
  /** our 1-based position in the alerts view (pump failures come first) */
  ourOrder: number | null;
  orderOk: boolean | null;
  revenueOk: boolean | null;
}

export interface PlanRow {
  label: AnswerKeyEvent;
  ref: ReferenceAction;
  ours: { cost: number; actions: PlanAction[]; doNothingCost: number } | null;
  /** ours ≤ ref + tol */
  pass: boolean | null;
  /** ours < ref − tol: "better than reference?" */
  better: boolean;
}

export interface SystemPlanResult {
  systemId: string;
  plan: Attempt<SystemPlan>;
  refTotal: number | null;
  rows: PlanRow[];
  pass: boolean | null;
  better: boolean;
  /** detected mode: failures in a system with no labelled ongoing failures */
  unlabelled?: boolean;
}

export interface SnapshotModeResult {
  mode: 'oracle' | 'detected';
  available: Attempt<true>;
  countdown: CountdownRow[];
  orderOk: boolean | null;
  systems: SystemPlanResult[];
}

export function costCheck(ours: number | null | undefined, ref: number | null | undefined, tol: number) {
  if (ours == null || ref == null) return { pass: null as boolean | null, better: false };
  return { pass: ours <= ref + tol, better: ours < ref - tol };
}

interface FailureCase {
  key: string;
  label: AnswerKeyEvent | null;
  facilityId: string;
  systemId: string;
  onsetUnix: number;
}

function runMode(
  mode: 'oracle' | 'detected',
  model: DatasetModel,
  grid: Grid,
  ongoingLabels: AnswerKeyEvent[],
  cases: FailureCase[],
  otherOngoing: { key: string; category: AlertItem['category']; onsetUnix: number }[],
  tol: Tolerances,
): SnapshotModeResult {
  const nowUnix = gridNow(grid);
  const cds = new Map(cases.map((c) => [c.key, attempt(() => countdownAt(model, grid, c.facilityId, nowUnix))]));

  // Alert order over our ongoing items.
  const cdOk = [...cds.values()].every((a) => a.ok);
  const positions = new Map<string, number>();
  if (cdOk) {
    const items: AlertItem[] = [
      ...cases.map((c) => {
        const cd = cds.get(c.key)!;
        return {
          key: c.key,
          category: 'pump_failure' as const,
          status: 'ongoing' as const,
          hoursToLimit: cd.ok ? cd.value.hoursToLimitP50 : null,
          lostRevenuePerHour: model.facilityById.get(c.facilityId)?.revenuePerHour ?? 0,
          onsetUnix: c.onsetUnix,
        };
      }),
      ...otherOngoing.map((o) => ({ ...o, status: 'ongoing' as const, hoursToLimit: null, lostRevenuePerHour: 0 })),
    ];
    orderAlerts(items).forEach((it, i) => positions.set(it.key, i + 1));
  }

  const pumpLabels = ongoingLabels.filter((l) => l.category === 'pump_failure');
  const countdown: CountdownRow[] = pumpLabels.map((label) => {
    const c = cases.find((x) => x.label?.id === label.id);
    const cd: Attempt<Countdown> = c ? cds.get(c.key)! : { ok: false, error: 'not detected', notImplemented: false };
    const ourOrder = c ? positions.get(c.key) ?? null : null;
    const rev = model.facilityById.get(label.facility)?.revenuePerHour;
    // not detected → ✗; stub → N/A; other error → ✗
    const cmp = (ref: number | null, ours: (v: Countdown) => number | null, t: number): boolean | null => {
      if (!c) return false;
      if (!cd.ok) return cd.notImplemented ? null : false;
      if (ref == null) return null;
      const v = ours(cd.value);
      return v != null && Math.abs(v - ref) <= t;
    };
    let orderOk: boolean | null = null;
    if (label.order != null) {
      if (!c) orderOk = false;
      else if (!cdOk) orderOk = [...cds.values()].some((a) => !a.ok && !a.notImplemented) ? false : null;
      else orderOk = ourOrder === label.order;
    }
    return {
      label,
      countdown: cd,
      levelOk: cmp(label.levelFinalPct, (v) => v.levelPct, tol.levelPct),
      hoursOk: cmp(label.hoursToLimitFinal, (v) => v.hoursToLimitP50, tol.hours),
      ourOrder,
      orderOk,
      revenueOk: label.lostRevenuePerHour == null || rev == null ? null : Math.abs(label.lostRevenuePerHour - rev) < 0.01,
    };
  });
  const orderVals = countdown.map((r) => r.orderOk).filter((x) => x !== null);
  const orderOk = orderVals.length ? orderVals.every(Boolean) : null;

  // Joint plans per system.
  const systemIds = [...new Set([...pumpLabels.map((l) => l.system), ...cases.map((c) => c.systemId)])];
  const systems: SystemPlanResult[] = systemIds.map((systemId) => {
    const sysCases = cases.filter((c) => c.systemId === systemId);
    const sysLabels = pumpLabels.filter((l) => l.system === systemId);
    const refCosts = sysLabels.map((l) => l.reference.cost);
    const refTotal = refCosts.length && refCosts.every((x) => x != null) ? refCosts.reduce((a, b) => a + (b as number), 0) : null;
    const failures: FailureInput[] = sysCases.map((c) => {
      const cd = cds.get(c.key)!;
      const level = cd.ok ? cd.value.levelPct : tankLevelAt(model, grid, c.facilityId, nowUnix) ?? 0;
      return {
        eventId: c.key,
        facilityId: c.facilityId,
        levelPct: level,
        repairEndUnix: c.onsetUnix + model.repairHoursPumpFailure * 3600,
        alreadyTripped: cd.ok ? cd.value.alreadyTripped : level >= model.shutdownPct,
      };
    });
    const plan: Attempt<SystemPlan> = failures.length
      ? attempt(() => planSystem({ model, systemId, nowUnix, failures, onsetUnixByEvent: Object.fromEntries(sysCases.map((c) => [c.key, c.onsetUnix])) }))
      : { ok: false, error: 'no failures detected in this system', notImplemented: false };
    const rows: PlanRow[] = sysLabels.map((label) => {
      const c = sysCases.find((x) => x.label?.id === label.id);
      const fp = plan.ok && c ? plan.value.facilities.find((f) => f.eventId === c.key) ?? plan.value.facilities.find((f) => f.facilityId === c.facilityId) : undefined;
      const ours = fp ? { cost: fp.cost, actions: fp.actions, doNothingCost: fp.doNothingCost } : null;
      const cc = costCheck(ours?.cost, label.reference.cost, tol.costUsd);
      return { label, ref: label.reference, ours, ...cc };
    });
    const sc = plan.ok
      ? costCheck(plan.value.totalCost, sysLabels.length ? refTotal : 0, tol.costUsd)
      : { pass: plan.notImplemented ? null : false, better: false };
    return { systemId, plan, refTotal, rows, ...sc, unlabelled: sysLabels.length === 0 };
  });

  return { mode, available: { ok: true, value: true }, countdown, orderOk, systems };
}

export function scoreSnapshotOracle(model: DatasetModel, grid: Grid, labels: AnswerKeyEvent[], tol: Tolerances): SnapshotModeResult {
  const ongoing = labels.filter((l) => l.status === 'ongoing');
  const cases: FailureCase[] = ongoing
    .filter((l) => l.category === 'pump_failure')
    .map((l) => ({ key: l.id, label: l, facilityId: l.facility, systemId: l.system, onsetUnix: l.onsetUnix }));
  const others = ongoing
    .filter((l) => l.category !== 'pump_failure')
    .map((l) => ({ key: l.id, category: l.category as AlertItem['category'], onsetUnix: l.onsetUnix }));
  return runMode('oracle', model, grid, ongoing, cases, others, tol);
}

export function scoreSnapshotDetected(
  model: DatasetModel,
  grid: Grid,
  labels: AnswerKeyEvent[],
  detected: Attempt<DetectedEvent[]>,
  tol: Tolerances,
  mo: MatchOptions,
): SnapshotModeResult {
  const ongoing = labels.filter((l) => l.status === 'ongoing');
  if (!detected.ok) return { mode: 'detected', available: detected, countdown: [], orderOk: null, systems: [] };
  const nowUnix = gridNow(grid);
  const evs = detected.value.filter((e) => e.status === 'ongoing');
  const m = matchEvents(ongoing, evs, nowUnix, mo);
  const labelOf = new Map<DetectedEvent, AnswerKeyEvent>();
  for (const x of m.matches) if (x.detected) labelOf.set(x.detected, x.label);
  const key = (e: DetectedEvent) => `${e.assetId}@${e.onsetUnix}`;
  const cases: FailureCase[] = evs
    .filter((e) => e.category === 'pump_failure')
    .map((e) => ({ key: key(e), label: labelOf.get(e) ?? null, facilityId: e.facilityId, systemId: e.systemId, onsetUnix: e.onsetUnix }));
  const others = evs.filter((e) => e.category !== 'pump_failure').map((e) => ({ key: key(e), category: e.category, onsetUnix: e.onsetUnix }));
  return runMode('detected', model, grid, ongoing, cases, others, tol);
}
