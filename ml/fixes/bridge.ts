// Planner bridge for the Python /fixes endpoint (ml/fixes_service.py).
//
// Runs the backend's exact core code (countdownAt + planSystem) so /fixes costs can never
// drift from the console's plans. Long-lived process: one JSON request per stdin line,
// one JSON response per stdout line.  Start: npx tsx ml/fixes/bridge.ts
//
// Request:  {"id": 1, "op": "plan", "datasetDir": "...", "asOfUnix": 1791460800 | null,
//            "failures": [{"eventId": "...", "facilityId": "...", "onsetUnix": 0}],
//            "targetEventId": "...", "overrides": {...}}
//   failures = every ongoing pump failure in the target's system (they share the fleet).
// Response: {"id": 1, "ok": true, "result": {...}} or {"id": 1, "ok": false, "error": "..."}
import { readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { buildModel, type DatasetModel } from '../../core/src/model';
import { parseTelemetryCsv, truncateGrid, tEnd, type Grid } from '../../core/src/telemetry';
import { countdownAt } from '../../core/src/countdown';
import { planSystem, type FailureInput, type FacilityPlan, type PlanOverrides } from '../../core/src/planner';

interface Loaded {
  key: string;
  model: DatasetModel;
  grid: Grid;
}
const cache = new Map<string, Loaded>();

function loadDataset(dir: string): Loaded {
  const abs = resolve(dir);
  const mtime = statSync(join(abs, 'telemetry.csv')).mtimeMs;
  const key = `${abs}|${mtime}`;
  const hit = cache.get(abs);
  if (hit && hit.key === key) return hit;
  const model = buildModel(
    JSON.parse(readFileSync(join(abs, 'network.json'), 'utf8')),
    JSON.parse(readFileSync(join(abs, 'ops.json'), 'utf8')),
  );
  const grid = parseTelemetryCsv(readFileSync(join(abs, 'telemetry.csv'), 'utf8'));
  const loaded = { key, model, grid };
  cache.set(abs, loaded);
  return loaded;
}

interface PlanReq {
  datasetDir: string;
  asOfUnix?: number | null;
  failures: { eventId: string; facilityId: string; onsetUnix: number }[];
  targetEventId: string;
  overrides?: PlanOverrides;
}

function slim(p: FacilityPlan) {
  return p; // keep everything: Python builds the timeline from arrivals, trace, trip and free times
}

function plan(req: PlanReq) {
  const { model, grid: full } = loadDataset(req.datasetDir);
  const asOf = req.asOfUnix ?? tEnd(full);
  const grid = req.asOfUnix != null ? truncateGrid(full, req.asOfUnix) : full;
  const target = req.failures.find((f) => f.eventId === req.targetEventId);
  if (!target) throw new Error(`targetEventId ${req.targetEventId} is not in failures`);
  const targetFac = model.facilityById.get(target.facilityId);
  if (!targetFac) throw new Error(`unknown facility ${target.facilityId}`);
  const systemId = targetFac.systemId;
  const ov = req.overrides ?? {};
  const onsetUnixByEvent: Record<string, number> = {};

  // Same FailureInput construction as core/src/analyze.ts
  const countdowns: Record<string, unknown> = {};
  const failures: FailureInput[] = req.failures.map((f) => {
    const fac = model.facilityById.get(f.facilityId);
    if (!fac) throw new Error(`unknown facility ${f.facilityId}`);
    if (fac.systemId !== systemId) throw new Error(`${f.facilityId} is not in system ${systemId}`);
    onsetUnixByEvent[f.eventId] = f.onsetUnix;
    const cd = countdownAt(model, grid, f.facilityId, asOf, { sinceUnix: f.onsetUnix });
    countdowns[f.eventId] = cd;
    const producing = new Set(cd.producingWells);
    return {
      eventId: f.eventId,
      facilityId: f.facilityId,
      levelPct: cd.levelPct,
      repairEndUnix: f.onsetUnix + model.repairHoursPumpFailure * 3600,
      alreadyTripped: cd.alreadyTripped,
      wellsOff: fac.wells.filter((w) => !producing.has(w.id)).map((w) => w.id),
    };
  });

  // 1. joint optimum for the whole system (what the console recommends)
  const joint = planSystem({ model, systemId, nowUnix: asOf, failures, overrides: ov, onsetUnixByEvent });
  const recommended = joint.facilities.find((f) => f.eventId === req.targetEventId)!;

  // 2. alternatives for the target only, with the other events held at their joint plans:
  //    their trucks are busy, so the target can only use what is left.
  const othersBusy = joint.facilities.filter((f) => f.eventId !== req.targetEventId).flatMap((f) => f.truckFreeAtUnix);
  const tFail = failures.find((f) => f.eventId === req.targetEventId)!;
  const targetWells = targetFac.wells.map((w) => w.id);
  const solo = (o: PlanOverrides) =>
    planSystem({
      model,
      systemId,
      nowUnix: asOf,
      failures: [tFail],
      overrides: { ...ov, ...o },
      onsetUnixByEvent,
      busyTruckFreeAtUnix: othersBusy,
    }).facilities[0];
  const lockAll = [...(ov.lockedWells ?? []), ...targetWells];
  const trucksOnly = solo({ lockedWells: lockAll });
  const shutInOnly = solo({ noTrucks: true });
  const doNothing = solo({ noTrucks: true, lockedWells: lockAll });

  return {
    asOfUnix: asOf,
    systemId,
    fleetSize: joint.fleetSize,
    trucksAvailable: joint.trucksAvailable,
    othersTrucksUsed: joint.facilities.filter((f) => f.eventId !== req.targetEventId).reduce((a, f) => a + f.trucks, 0),
    jointTotalCost: joint.totalCost,
    countdown: countdowns[req.targetEventId],
    model: {
      warningPct: model.warningPct,
      shutdownPct: model.shutdownPct,
      oilPerBbl: model.oilPerBbl,
      gasPerMcf: model.gasPerMcf,
      truckCapacityBbl: ov.truckCapacityBbl ?? model.truckCapacityBbl,
      costPerTrip: ov.costPerTrip ?? model.costPerTrip,
      capacityBbl: targetFac.capacityBbl,
      responseMin: targetFac.responseMin,
      cycleMin: targetFac.cycleMin,
      facilityRevenuePerHour: targetFac.revenuePerHour,
      wells: targetFac.wells.map((w) => ({
        id: w.id,
        oilBpd: w.oilBpd,
        gasMcfd: w.gasMcfd,
        baselineWaterBpd: w.baselineWaterBpd,
        revenuePerHour: w.revenuePerHour,
      })),
    },
    variants: {
      recommended: slim(recommended),
      trucksOnly: slim(trucksOnly),
      shutInOnly: slim(shutInOnly),
      doNothing: slim(doNothing),
    },
  };
}

const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let id: unknown = null;
  try {
    const req = JSON.parse(line);
    id = req.id ?? null;
    if (req.op === 'ping') {
      process.stdout.write(JSON.stringify({ id, ok: true, result: 'pong' }) + '\n');
      return;
    }
    if (req.op !== 'plan') throw new Error(`unknown op ${req.op}`);
    process.stdout.write(JSON.stringify({ id, ok: true, result: plan(req) }) + '\n');
  } catch (e) {
    process.stdout.write(JSON.stringify({ id, ok: false, error: (e as Error).message }) + '\n');
  }
});
