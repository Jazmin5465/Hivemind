// The full causal pipeline the module runs on recompute_events, as a pure function:
// detect (ML probabilities if present, else rules) -> injected overlays -> countdowns ->
// alert order -> joint plans per system (respecting trucks busy on approved plans).
import type { DatasetModel } from './model';
import { gridGet, idxAtOrBefore, tsAt, type Grid } from './telemetry';
import type { DetectedEvent } from './types';
import { detectRules } from './detector/rules';
import { detectFromMl, hasMlSeries, mlCoverageEndIdx } from './mlEvents';
import { countdownAt, type Countdown } from './countdown';
import { orderAlerts } from './alerts';
import { planSystem, type FailureInput, type SystemPlan } from './planner';

export type DetectorMode = 'auto' | 'rules' | 'ml';

export interface InjectedFailure {
  facilityId: string;
  onsetUnix: number;
  levelPct: number;
}

/** Plans the operator already approved: their events are handled and their trucks are busy. */
export interface CommittedPlan {
  systemId: string;
  eventIds: string[];
  planStartUnix: number;
  truckFreeAtUnix: number[];
}

export interface AnalyzeInput {
  model: DatasetModel;
  grid: Grid;
  asOfUnix: number;
  detector?: DetectorMode;
  injected?: InjectedFailure[];
  committed?: CommittedPlan[];
  mlModelVersion?: string;
  /** skip planning (e.g. fast scrubbing) */
  skipPlans?: boolean;
}

export interface AnalyzedEvent extends DetectedEvent {
  eventId: string;
  lostRevenuePerHour: number;
  repairEndUnix: number | null;
  countdown: Countdown | null;
  /** 1-based position in the alerts view; 0 = not shown (resolved) */
  alertRank: number;
  action: 'plan' | 'field_inspection';
  /** id of a committed plan that covers this event, if any */
  committed: boolean;
}

export interface AnalyzeOutput {
  asOfUnix: number;
  detectorUsed: 'rules' | 'ml';
  detectorError: string | null;
  events: AnalyzedEvent[];
  plans: SystemPlan[];
}

export const eventKey = (e: Pick<DetectedEvent, 'category' | 'assetId' | 'onsetUnix'>) =>
  `${e.category}:${e.assetId}:${e.onsetUnix}`;

function runDetector(input: AnalyzeInput): { events: DetectedEvent[]; used: 'rules' | 'ml'; error: string | null } {
  const { model, grid, asOfUnix } = input;
  const mode = input.detector ?? 'auto';
  let rules: DetectedEvent[] = [];
  let error: string | null = null;
  try {
    rules = detectRules(model, grid, { asOfUnix });
  } catch (e) {
    error = `rules detector: ${(e as Error).message}`;
  }
  const mlOk = mode !== 'rules' && hasMlSeries(model, grid);
  if (!mlOk) return { events: rules, used: 'rules', error };
  const mlEnd = tsAt(grid, mlCoverageEndIdx(model, grid));
  if (mlEnd < asOfUnix && mode === 'auto') {
    // ML results don't reach the clock (sidecar ran on older data): use rules
    return { events: rules, used: 'rules', error };
  }
  const ml = detectFromMl(model, grid, { asOfUnix, modelVersion: input.mlModelVersion });
  // Pump status == 2 is unambiguous: keep rules pump failures the ML missed.
  const merged = [...ml];
  for (const r of rules) {
    if (r.category !== 'pump_failure') continue;
    const overlap = ml.some(
      (m) =>
        m.category === r.category &&
        m.assetId === r.assetId &&
        m.onsetUnix <= (r.endUnix ?? Infinity) &&
        r.onsetUnix <= (m.endUnix ?? Infinity),
    );
    if (!overlap) merged.push(r);
  }
  // Use the rules' evidence text alongside ML's for matching events
  for (const m of merged) {
    if (m.source !== 'ml') continue;
    const r = rules.find((x) => x.category === m.category && x.assetId === m.assetId && x.onsetUnix <= (m.endUnix ?? Infinity) && m.onsetUnix <= (x.endUnix ?? Infinity));
    if (r) m.evidence = [...m.evidence, ...r.evidence].slice(0, 3);
  }
  return { events: merged, used: 'ml', error };
}

function injectedEvents(input: AnalyzeInput): { ev: DetectedEvent; inj: InjectedFailure }[] {
  const { model, asOfUnix } = input;
  const out: { ev: DetectedEvent; inj: InjectedFailure }[] = [];
  for (const inj of input.injected ?? []) {
    if (inj.onsetUnix > asOfUnix) continue;
    const fac = model.facilityById.get(inj.facilityId);
    if (!fac) continue;
    const end = inj.onsetUnix + model.repairHoursPumpFailure * 3600;
    out.push({
      inj,
      ev: {
        category: 'pump_failure',
        systemId: fac.systemId,
        facilityId: fac.id,
        assetId: fac.pumpId,
        onsetUnix: inj.onsetUnix,
        endUnix: end <= asOfUnix ? end : null,
        status: end <= asOfUnix ? 'resolved' : 'ongoing',
        confidence: 1,
        source: 'injected',
        evidence: [`Demo overlay: pump failure injected at ${new Date(inj.onsetUnix * 1000).toISOString().slice(11, 16)} UTC with the tank at ${inj.levelPct.toFixed(0)}%`],
      },
    });
  }
  return out;
}

/** Countdown for an injected failure: physics from the injected onset level. */
function injectedCountdown(input: AnalyzeInput, inj: InjectedFailure): Countdown {
  const { model, asOfUnix } = input;
  const fac = model.facilityById.get(inj.facilityId)!;
  const rate = (fac.baselineInflowBpd / 24 / fac.capacityBbl) * 100;
  const level = Math.min(model.shutdownPct, inj.levelPct + (rate * (asOfUnix - inj.onsetUnix)) / 3600);
  const tripped = level >= model.shutdownPct - 1e-9;
  const p50 = tripped ? 0 : (model.shutdownPct - level) / rate;
  return {
    facilityId: fac.id,
    asOfUnix,
    levelPct: level,
    levelPctRaw: level,
    inflowBpd: tripped ? 0 : fac.baselineInflowBpd,
    ratePctPerHour: rate,
    observedRatePctPerHour: null,
    hoursToLimitP50: p50,
    hoursToLimitP10: p50 * 0.9,
    hoursToLimitP90: p50 * 1.1,
    tripsAtUnix: asOfUnix + p50 * 3600,
    alreadyTripped: tripped,
    producingWells: tripped ? [] : fac.wells.map((w) => w.id),
  } as Countdown;
}

export function analyze(input: AnalyzeInput): AnalyzeOutput {
  const { model, grid, asOfUnix } = input;
  const det = runDetector(input);
  const inj = injectedEvents(input);
  const committedIds = new Set((input.committed ?? []).filter((c) => c.planStartUnix <= asOfUnix).flatMap((c) => c.eventIds));

  const events: AnalyzedEvent[] = [];
  const add = (ev: DetectedEvent, cd: Countdown | null) => {
    const fac = model.facilityById.get(ev.facilityId);
    const isFail = ev.category === 'pump_failure';
    const id = eventKey(ev);
    events.push({
      ...ev,
      eventId: id,
      lostRevenuePerHour: fac?.revenuePerHour ?? 0,
      repairEndUnix: isFail ? ev.onsetUnix + model.repairHoursPumpFailure * 3600 : null,
      countdown: cd,
      alertRank: 0,
      action: isFail ? 'plan' : 'field_inspection',
      committed: committedIds.has(id),
    });
  };
  for (const ev of det.events) {
    const cd =
      ev.category === 'pump_failure' && ev.status === 'ongoing'
        ? countdownAt(model, grid, ev.facilityId, asOfUnix, { sinceUnix: ev.onsetUnix })
        : null;
    add(ev, cd);
  }
  for (const { ev, inj: i } of inj) {
    // an injected failure on a facility whose pump already failed in the data is redundant
    const dup = events.some((e) => e.category === 'pump_failure' && e.facilityId === ev.facilityId && e.status === 'ongoing');
    if (dup) continue;
    add(ev, ev.status === 'ongoing' ? injectedCountdown(input, i) : null);
  }

  const ordered = orderAlerts(
    events.map((e) => ({ ...e, key: e.eventId, hoursToLimit: e.countdown?.hoursToLimitP50 ?? null })),
  );
  ordered.forEach((o, i) => {
    const e = events.find((x) => x.eventId === o.key)!;
    e.alertRank = i + 1;
  });

  const plans: SystemPlan[] = [];
  if (!input.skipPlans) {
    const bySystem = new Map<string, AnalyzedEvent[]>();
    for (const e of events) {
      if (e.category !== 'pump_failure' || e.status !== 'ongoing' || e.committed || !e.countdown) continue;
      bySystem.set(e.systemId, [...(bySystem.get(e.systemId) ?? []), e]);
    }
    for (const [systemId, evs] of bySystem) {
      const failures: FailureInput[] = evs.map((e) => {
        const fac = model.facilityById.get(e.facilityId)!;
        const producing = new Set(e.countdown!.producingWells);
        return {
          eventId: e.eventId,
          facilityId: e.facilityId,
          levelPct: e.countdown!.levelPct,
          repairEndUnix: e.repairEndUnix!,
          alreadyTripped: e.countdown!.alreadyTripped,
          wellsOff: fac.wells.filter((w) => !producing.has(w.id)).map((w) => w.id),
        };
      });
      const busy = (input.committed ?? [])
        .filter((c) => c.systemId === systemId && c.planStartUnix <= asOfUnix)
        .flatMap((c) => c.truckFreeAtUnix);
      plans.push(planSystem({ model, systemId, nowUnix: asOfUnix, failures, busyTruckFreeAtUnix: busy }));
    }
  }
  events.sort((a, b) => (a.alertRank || 1e9) - (b.alertRank || 1e9) || a.onsetUnix - b.onsetUnix);
  return { asOfUnix, detectorUsed: det.used, detectorError: det.error, events, plans };
}

/** Latest readings for every facility at asOfUnix (map view). */
export function facilitySnapshot(model: DatasetModel, grid: Grid, asOfUnix: number) {
  const idx = idxAtOrBefore(grid, asOfUnix);
  const val = (asset: string, metric: string) => {
    const a = gridGet(grid, asset, metric);
    if (!a || idx < 0) return NaN;
    for (let j = idx; j >= 0; j--) if (Number.isFinite(a[j])) return a[j];
    return NaN;
  };
  return model.facilities.map((f) => ({
    facilityId: f.id,
    systemId: f.systemId,
    levelPct: val(f.tankId, 'level_pct'),
    inflowBpd: val(f.id, 'inflow_bpd'),
    pumpStatus: val(f.pumpId, 'status'),
    pumpFlowBpd: val(f.pumpId, 'flow_bpd'),
    dischargePsi: val(f.pumpId, 'discharge_psi'),
    receiveFlowBpd: val(f.pipelineId, 'receive_flow_bpd'),
    pipelinePressurePsi: val(f.pipelineId, 'pressure_psi'),
    wellsProducing: f.wells.filter((w) => {
      const s = val(w.id, 'status');
      return !Number.isFinite(s) || s >= 0.5;
    }).length,
    wellsTotal: f.wells.length,
    wellIds: f.wells.map((w) => w.id),
    wellStatus: f.wells.map((w) => val(w.id, 'status')),
    wellWaterBpd: f.wells.map((w) => val(w.id, 'water_bpd')),
  }));
}
