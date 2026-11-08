// Folders where every label is resolved (full_week): "planned at each onset, assuming earlier plans were followed".
// Replays pump failures in onset order; each is planned alone at its onset, with trucks still busy on
// earlier plans in the same system passed as busyTruckFreeAtUnix.
import type { DatasetModel } from '../../core/src/model';
import type { Grid } from '../../core/src/telemetry';
import type { PlanAction } from '../../core/src/types';
import { planSystem, type FacilityPlan, type SystemPlan } from '../../core/src/planner';
import type { AnswerKeyEvent, ReferenceAction } from './answerKey';
import { attempt, tankLevelAt, plannedLevelAt, type Attempt } from './common';
import { costCheck } from './snapshot';

export type BusySource = 'ours' | 'ref';

export interface ReplayRow {
  label: AnswerKeyEvent;
  levelPct: number | null;
  levelSource: 'telemetry' | 'label';
  busyFreeAtUnix: number[];
  fleetSize: number;
  ourFree: number;
  refFree: number;
  freeOk: boolean;
  plan: Attempt<SystemPlan>;
  ours: FacilityPlan | null;
  ref: ReferenceAction;
  pass: boolean | null;
  better: boolean;
}

export interface Sanity {
  label: AnswerKeyEvent;
  plan: Attempt<SystemPlan>;
  /** planner with fleetSize 0: cheapest plan without trucks (shut-in or do nothing) */
  noTrucks: Attempt<SystemPlan>;
  doNothingCost: number | null;
  noTruckCost: number | null;
  planCost: number | null;
  actions: PlanAction[] | null;
  pass: boolean | null;
}

export interface ReplayResult {
  busySource: BusySource;
  rows: ReplayRow[];
  refTotal: number;
  ourTotal: number | null;
  sanity: Sanity | null;
}

/** Truck free times implied by a reference plan: free = onset + response + trips × cycle. */
function refTruckFreeAt(model: DatasetModel, label: AnswerKeyEvent): number[] {
  const f = model.facilityById.get(label.facility);
  const r = label.reference;
  if (!f || r.trucks <= 0) return [];
  const trips = r.tripsPerTruck ?? Math.ceil(r.totalTrips / r.trucks);
  return Array.from({ length: r.trucks }, () => label.onsetUnix + (f.responseMin + trips * f.cycleMin) * 60);
}

export function replayFullWeek(model: DatasetModel, grid: Grid, labels: AnswerKeyEvent[], tolUsd: number, busySource: BusySource): ReplayResult {
  const pumps = labels.filter((l) => l.category === 'pump_failure').sort((a, b) => a.onsetUnix - b.onsetUnix);
  const busyBySystem = new Map<string, number[]>();
  const rows: ReplayRow[] = [];
  let ourTotal: number | null = 0;
  let refTotal = 0;

  for (const label of pumps) {
    const fleetSize = model.systemById.get(label.system)?.fleetSize ?? 0;
    const busy = (busyBySystem.get(label.system) ?? []).filter((t) => t > label.onsetUnix);
    const tel = plannedLevelAt(model, grid, label.facility, label.onsetUnix, label.onsetUnix);
    const levelPct = tel ?? label.levelPct;
    const plan = attempt(() =>
      planSystem({
        model,
        systemId: label.system,
        nowUnix: label.onsetUnix,
        failures: [
          {
            eventId: label.id,
            facilityId: label.facility,
            levelPct: levelPct ?? 0,
            repairEndUnix: label.onsetUnix + model.repairHoursPumpFailure * 3600,
            alreadyTripped: levelPct != null && levelPct >= model.shutdownPct,
          },
        ],
        busyTruckFreeAtUnix: busy,
        onsetUnixByEvent: { [label.id]: label.onsetUnix },
      }),
    );
    const ours = plan.ok ? plan.value.facilities.find((f) => f.eventId === label.id) ?? plan.value.facilities[0] ?? null : null;
    // ours: our plan's trucks (falls back to the reference plan while the planner is unavailable)
    const freeTimes = busySource === 'ours' && ours ? ours.truckFreeAtUnix : refTruckFreeAt(model, label);
    busyBySystem.set(label.system, [...busy, ...freeTimes]);

    const ourFree = Math.max(0, fleetSize - busy.length);
    const refFree = label.reference.trucksFree ?? fleetSize;
    const cc = plan.ok ? costCheck(ours?.cost, label.reference.cost, tolUsd) : { pass: plan.notImplemented ? null : false, better: false };
    if (ours && ourTotal != null) ourTotal += ours.cost;
    else ourTotal = null;
    refTotal += label.reference.cost ?? 0;
    rows.push({
      label,
      levelPct,
      levelSource: tel != null ? 'telemetry' : 'label',
      busyFreeAtUnix: busy,
      fleetSize,
      ourFree,
      refFree,
      freeOk: ourFree === refFree,
      plan,
      ours,
      ref: label.reference,
      ...cc,
    });
  }

  // README-style sanity: first pump failure whose reference is a single truck trip, planned with all trucks free.
  let sanity: Sanity | null = null;
  const ex = pumps.find((l) => l.reference.kind === 'truck' && l.reference.trucks === 1 && l.reference.tripsPerTruck === 1 && l.reference.trucksFree == null);
  if (ex) {
    const level = plannedLevelAt(model, grid, ex.facility, ex.onsetUnix, ex.onsetUnix) ?? ex.levelPct ?? 0;
    const input = {
      model,
      systemId: ex.system,
      nowUnix: ex.onsetUnix,
      failures: [{ eventId: ex.id, facilityId: ex.facility, levelPct: level, repairEndUnix: ex.onsetUnix + model.repairHoursPumpFailure * 3600 }],
    };
    const plan = attempt(() => planSystem(input));
    const noTrucks = attempt(() => planSystem({ ...input, overrides: { fleetSize: 0 } }));
    const fp = plan.ok ? plan.value.facilities[0] : null;
    sanity = {
      label: ex,
      plan,
      noTrucks,
      doNothingCost: fp?.doNothingCost ?? null,
      noTruckCost: noTrucks.ok ? noTrucks.value.totalCost : null,
      planCost: plan.ok ? plan.value.totalCost : null,
      actions: fp?.actions ?? null,
      pass: plan.ok ? costCheck(plan.value.totalCost, ex.reference.cost, tolUsd).pass : plan.notImplemented ? null : false,
    };
  }
  return { busySource, rows, refTotal, ourTotal, sanity };
}
