// Mirrors the module's planner inputs for one dataset at the clock: ongoing pump failures not
// covered by an approved plan, their tank levels, and trucks busy on approved plans.
import type { DatasetModel } from '../../../core/src/model';
import type { Grid } from '../../../core/src/telemetry';
import { countdownAt } from '../../../core/src/countdown';
import type { FailureInput } from '../../../core/src/planner';
import type { AgentBackend, AgentState, DatasetRow, EventRow, PlanRow } from './state';

export interface DatasetCtx {
  ds: DatasetRow;
  state: AgentState;
  model: DatasetModel;
  grid: Grid;
  nowUnix: number;
  events: EventRow[];
}

export function datasetCtx(backend: AgentBackend, datasetId: string): DatasetCtx {
  const state = backend.state();
  const ds = state.datasets.find((d) => d.datasetId === datasetId);
  if (!ds) throw new Error(`unknown dataset ${datasetId}`);
  const { model, grid } = backend.loadData(ds);
  const clock = state.clocks.find((c) => c.datasetId === datasetId);
  return { ds, state, model, grid, nowUnix: clock?.nowUnix ?? ds.tEnd, events: state.events.filter((e) => e.datasetId === datasetId) };
}

export function approvedPlans(c: DatasetCtx): PlanRow[] {
  return c.state.plans.filter((p) => p.datasetId === c.ds.datasetId && p.status === 'approved' && p.planStartUnix <= c.nowUnix);
}

export function busyTrucks(c: DatasetCtx, systemId: string): number[] {
  const ids = new Set(approvedPlans(c).filter((p) => p.systemId === systemId).map((p) => p.planId));
  return c.state.planFacilities.filter((f) => ids.has(f.planId)).flatMap((f) => f.truckFreeAtUnix).filter((t) => t > c.nowUnix);
}

export function coveredEventIds(c: DatasetCtx): Set<string> {
  return new Set(approvedPlans(c).flatMap((p) => p.eventIds));
}

/** Planner inputs for a system's ongoing, unplanned pump failures. */
export function systemFailures(c: DatasetCtx, systemId: string): { failures: FailureInput[]; onsetByEvent: Record<string, number> } {
  const covered = coveredEventIds(c);
  const failures: FailureInput[] = [];
  const onsetByEvent: Record<string, number> = {};
  for (const e of c.events) {
    if (e.systemId !== systemId || e.category !== 'pump_failure' || e.status !== 'ongoing' || covered.has(e.eventId)) continue;
    const fac = c.model.facilityById.get(e.facilityId);
    if (!fac) continue;
    let levelPct = e.levelPct ?? NaN;
    let alreadyTripped = false;
    let wellsOff: string[] = [];
    if (e.source !== 'injected') {
      const cd = countdownAt(c.model, c.grid, e.facilityId, c.nowUnix, { sinceUnix: e.onsetUnix });
      levelPct = cd.levelPct;
      alreadyTripped = cd.alreadyTripped;
      const prod = new Set(cd.producingWells);
      wellsOff = fac.wells.filter((w) => !prod.has(w.id)).map((w) => w.id);
    } else alreadyTripped = levelPct >= c.model.shutdownPct - 1e-9;
    failures.push({
      eventId: e.eventId,
      facilityId: e.facilityId,
      levelPct,
      repairEndUnix: e.repairEndUnix ?? e.onsetUnix + c.model.repairHoursPumpFailure * 3600,
      alreadyTripped,
      wellsOff,
    });
    onsetByEvent[e.eventId] = e.onsetUnix;
  }
  return { failures, onsetByEvent };
}

export const hhmm = (unix: number | null | undefined) =>
  unix == null || !Number.isFinite(unix) ? '-' : new Date(Math.round(unix / 60) * 60_000).toISOString().slice(11, 16);
export const usd = (x: number) => `$${Math.round(x).toLocaleString('en-US')}`;
export const hours1 = (h: number) => `${h.toFixed(1)} h`;
