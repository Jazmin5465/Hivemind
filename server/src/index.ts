// Hivemind module: reducers and lifecycle. Tables are in schema.ts; glue in logic.ts;
// all detection / countdown / planning logic is pure TS in ../../core.
import { SenderError, t } from 'spacetimedb/server';
import { ScheduleAt } from 'spacetimedb';
import spacetimedb, { ActionInput, clockTimer, Driver, PlanOverrides, SeriesChunk } from './schema';
import {
  committedPlans,
  deleteDatasetRows,
  deletePlan,
  dropCache,
  fullId,
  getData,
  isAdmin,
  operatorName,
  recompute,
  requireAdmin,
  requireDataset,
  requireReady,
  writePlan,
  type Ctx,
} from './logic';
import { buildModel } from '../../core/src/model';
import { countdownAt } from '../../core/src/countdown';
import { planSystem, type FailureInput, type PlanOverrides as CorePlanOverrides } from '../../core/src/planner';
import { validatePlan } from '../../core/src/validate';
import { analyze } from '../../core/src/analyze';
import { fleetSweep } from '../../core/src/fleetSweep';
import type { PlanAction } from '../../core/src/types';

export default spacetimedb;

const TICK_MICROS = 1_000_000n; // clock timer: once per real second

// ---------- lifecycle ----------
export const init = spacetimedb.init((ctx) => {
  ctx.db.admin.insert({ identity: ctx.sender, role: 'owner' });
  ctx.db.clockTimer.insert({ scheduledId: 0n, scheduledAt: ScheduleAt.interval(TICK_MICROS) });
});

export const onConnect = spacetimedb.clientConnected((ctx) => {
  const op = ctx.db.operator.identity.find(ctx.sender);
  if (op) ctx.db.operator.identity.update({ ...op, online: true, connections: op.connections + 1, lastSeen: ctx.timestamp });
  else
    ctx.db.operator.insert({
      identity: ctx.sender,
      name: `op-${ctx.sender.toHexString().slice(0, 6)}`,
      role: isAdmin(ctx) ? 'worker' : 'operator',
      online: true,
      connections: 1,
      lastSeen: ctx.timestamp,
    });
});

export const onDisconnect = spacetimedb.clientDisconnected((ctx) => {
  const op = ctx.db.operator.identity.find(ctx.sender);
  if (!op) return;
  const c = Math.max(0, op.connections - 1);
  ctx.db.operator.identity.update({ ...op, connections: c, online: c > 0, lastSeen: ctx.timestamp });
});

// ---------- auth ----------
/** Owner sets the shared worker key (from .env) once via the CLI. */
export const setWorkerKey = spacetimedb.reducer({ key: t.string() }, (ctx, { key }) => {
  const me = ctx.db.admin.identity.find(ctx.sender);
  if (!me || me.role !== 'owner') throw new SenderError('owner only');
  if (key.length < 16) throw new SenderError('worker key must be at least 16 characters');
  const cur = ctx.db.workerKey.id.find(1);
  if (cur) ctx.db.workerKey.id.update({ id: 1, key });
  else ctx.db.workerKey.insert({ id: 1, key });
});

/** The worker proves it knows the key and becomes an admin identity. */
export const registerWorker = spacetimedb.reducer({ key: t.string(), name: t.string() }, (ctx, { key, name }) => {
  const cur = ctx.db.workerKey.id.find(1);
  if (!cur || cur.key !== key) throw new SenderError('bad worker key');
  if (!ctx.db.admin.identity.find(ctx.sender)) ctx.db.admin.insert({ identity: ctx.sender, role: 'worker' });
  const op = ctx.db.operator.identity.find(ctx.sender);
  if (op) ctx.db.operator.identity.update({ ...op, name: name || op.name, role: 'agent' });
});

export const setName = spacetimedb.reducer({ name: t.string() }, (ctx, { name }) => {
  const n = name.trim().slice(0, 40);
  if (!n) throw new SenderError('name required');
  const op = ctx.db.operator.identity.find(ctx.sender);
  if (op) ctx.db.operator.identity.update({ ...op, name: n });
});

// ---------- dataset loading (worker) ----------
export const loadDatasetBegin = spacetimedb.reducer(
  { datasetId: t.string(), source: t.string(), networkJson: t.string(), opsJson: t.string() },
  (ctx, { datasetId, source, networkJson, opsJson }) => {
    requireAdmin(ctx);
    if (!/^[A-Za-z0-9_.-]{1,80}$/.test(datasetId)) throw new SenderError('datasetId must match [A-Za-z0-9_.-]{1,80}');
    let model;
    try {
      model = buildModel(JSON.parse(networkJson), JSON.parse(opsJson));
    } catch (e) {
      throw new SenderError(`invalid network/ops: ${(e as Error).message}`);
    }
    const prev = ctx.db.dataset.datasetId.find(datasetId);
    deleteDatasetRows(ctx, datasetId, true);
    const row = {
      datasetId,
      source,
      status: 'loading',
      error: '',
      tStart: 0,
      tEnd: 0,
      stepSec: 0,
      nSteps: 0,
      seriesCount: 0,
      rowCount: 0,
      active: prev?.active ?? false,
      loadVersion: (prev?.loadVersion ?? 0) + 1,
      loadedAt: ctx.timestamp,
      detector: 'rules',
    };
    if (prev) ctx.db.dataset.datasetId.update(row);
    else ctx.db.dataset.insert(row);
    ctx.db.datasetRaw.insert({ datasetId, networkJson, opsJson });

    const k = (id: string) => `${datasetId}/${id}`;
    for (const s of model.systems) {
      ctx.db.system.insert({
        key: k(s.id), datasetId, systemId: s.id, centerLat: s.centerLat, centerLon: s.centerLon,
        yardLat: s.yardLat, yardLon: s.yardLon, disposalId: s.disposalId, disposalLat: s.disposalLat,
        disposalLon: s.disposalLon, disposalPressurePsi: s.disposalPressurePsi,
      });
      ctx.db.opsSystem.insert({ key: k(s.id), datasetId, systemId: s.id, fleetSize: s.fleetSize });
    }
    for (const f of model.facilities) {
      ctx.db.facility.insert({
        key: k(f.id), datasetId, facilityId: f.id, systemId: f.systemId, lat: f.lat, lon: f.lon,
        tankId: f.tankId, capacityBbl: f.capacityBbl, pumpId: f.pumpId, maxFlowBpd: f.maxFlowBpd,
        startLevelPct: f.startLevelPct, stopLevelPct: f.stopLevelPct, pipelineId: f.pipelineId,
        pipelineMaxBpd: f.pipelineMaxBpd, pipelineMaxPressurePsi: f.pipelineMaxPressurePsi,
        baselineInflowBpd: f.baselineInflowBpd, revenuePerHour: f.revenuePerHour,
      });
      ctx.db.opsFacility.insert({ key: k(f.id), datasetId, facilityId: f.id, systemId: f.systemId, responseMin: f.responseMin, cycleMin: f.cycleMin });
      for (const w of f.wells)
        ctx.db.well.insert({
          key: k(w.id), datasetId, wellId: w.id, facilityId: f.id, systemId: f.systemId,
          baselineWaterBpd: w.baselineWaterBpd, oilBpd: w.oilBpd, gasMcfd: w.gasMcfd, revenuePerHour: w.revenuePerHour,
        });
    }
    ctx.db.opsConfig.insert({
      datasetId, oilPerBbl: model.oilPerBbl, gasPerMcf: model.gasPerMcf,
      repairHoursPumpFailure: model.repairHoursPumpFailure, truckCapacityBbl: model.truckCapacityBbl,
      costPerTrip: model.costPerTrip, warningPct: model.warningPct, shutdownPct: model.shutdownPct,
    });
  },
);

export const loadDatasetChunk = spacetimedb.reducer(
  { datasetId: t.string(), stepSec: t.u32(), chunks: t.array(SeriesChunk) },
  (ctx, { datasetId, stepSec, chunks }) => {
    requireAdmin(ctx);
    const d = requireDataset(ctx, datasetId);
    if (d.status !== 'loading') throw new SenderError(`dataset ${datasetId} is not loading`);
    for (const c of chunks) ctx.db.series.insert({ id: 0n, datasetId, assetId: c.assetId, metric: c.metric, chunkIdx: c.chunkIdx, t0: c.t0, stepSec, values: c.values });
  },
);

export const loadDatasetEnd = spacetimedb.reducer(
  {
    datasetId: t.string(), tStart: t.u32(), tEnd: t.u32(), stepSec: t.u32(), nSteps: t.u32(),
    seriesCount: t.u32(), rowCount: t.u32(), activate: t.bool(),
  },
  (ctx, a) => {
    requireAdmin(ctx);
    const d = requireDataset(ctx, a.datasetId);
    if (d.status !== 'loading') throw new SenderError(`dataset ${a.datasetId} is not loading`);
    if (a.tEnd < a.tStart || a.stepSec === 0 || a.nSteps !== Math.round((a.tEnd - a.tStart) / a.stepSec) + 1)
      throw new SenderError('inconsistent time range');
    ctx.db.dataset.datasetId.update({ ...d, status: 'ready', tStart: a.tStart, tEnd: a.tEnd, stepSec: a.stepSec, nSteps: a.nSteps, seriesCount: a.seriesCount, rowCount: a.rowCount });
    // "now" is the last ts_unix in the telemetry
    const clock = ctx.db.simClock.datasetId.find(a.datasetId);
    const c = { datasetId: a.datasetId, nowUnix: a.tEnd, playing: false, speed: clock?.speed ?? 300, carrySec: 0, computedForUnix: 0, computeMs: 0 };
    if (clock) ctx.db.simClock.datasetId.update(c);
    else ctx.db.simClock.insert(c);
    dropCache(a.datasetId);
    if (a.activate) activate(ctx, a.datasetId);
    recompute(ctx, a.datasetId);
  },
);

export const loadDatasetFail = spacetimedb.reducer({ datasetId: t.string(), error: t.string() }, (ctx, { datasetId, error }) => {
  requireAdmin(ctx);
  const d = ctx.db.dataset.datasetId.find(datasetId);
  if (d) ctx.db.dataset.datasetId.update({ ...d, status: 'error', error });
});

export const deleteDataset = spacetimedb.reducer({ datasetId: t.string() }, (ctx, { datasetId }) => {
  requireAdmin(ctx);
  deleteDatasetRows(ctx, datasetId, false);
  ctx.db.dataset.datasetId.delete(datasetId);
});

function activate(ctx: Ctx, datasetId: string) {
  for (const d of [...ctx.db.dataset.iter()]) {
    const want = d.datasetId === datasetId;
    if (d.active !== want) ctx.db.dataset.datasetId.update({ ...d, active: want });
  }
}

/** Flip the live app to another dataset (any operator). */
export const setActiveDataset = spacetimedb.reducer({ datasetId: t.string() }, (ctx, { datasetId }) => {
  requireReady(ctx, datasetId);
  activate(ctx, datasetId);
});

// ---------- clock ----------
function snap(d: { tStart: number; tEnd: number; stepSec: number }, unix: number) {
  const c = Math.min(d.tEnd, Math.max(d.tStart, unix));
  return d.tStart + Math.floor((c - d.tStart) / d.stepSec) * d.stepSec;
}

export const setClock = spacetimedb.reducer({ datasetId: t.string(), nowUnix: t.u32() }, (ctx, { datasetId, nowUnix }) => {
  const d = requireReady(ctx, datasetId);
  const clock = ctx.db.simClock.datasetId.find(datasetId)!;
  ctx.db.simClock.datasetId.update({ ...clock, nowUnix: snap(d, nowUnix), carrySec: 0 });
  recompute(ctx, datasetId);
});

export const play = spacetimedb.reducer({ datasetId: t.string(), speed: t.f64() }, (ctx, { datasetId, speed }) => {
  const d = requireReady(ctx, datasetId);
  if (!(speed > 0) || speed > 100_000) throw new SenderError('speed must be in (0, 100000] simulated seconds per second');
  const clock = ctx.db.simClock.datasetId.find(datasetId)!;
  const start = clock.nowUnix >= d.tEnd ? d.tStart : clock.nowUnix; // replay from the start if at the end
  ctx.db.simClock.datasetId.update({ ...clock, playing: true, speed, nowUnix: start, carrySec: 0 });
  if (start !== clock.nowUnix) recompute(ctx, datasetId);
});

export const pause = spacetimedb.reducer({ datasetId: t.string() }, (ctx, { datasetId }) => {
  requireDataset(ctx, datasetId);
  const clock = ctx.db.simClock.datasetId.find(datasetId);
  if (clock) ctx.db.simClock.datasetId.update({ ...clock, playing: false, carrySec: 0 });
});

/** Jump the clock back to the recording's "now" (last ts_unix). */
export const resetClock = spacetimedb.reducer({ datasetId: t.string() }, (ctx, { datasetId }) => {
  const d = requireReady(ctx, datasetId);
  const clock = ctx.db.simClock.datasetId.find(datasetId)!;
  ctx.db.simClock.datasetId.update({ ...clock, playing: false, nowUnix: d.tEnd, carrySec: 0 });
  recompute(ctx, datasetId);
});

export const tick = spacetimedb.reducer({ onSchedule: clockTimer }, { timer: clockTimer.rowType }, (ctx, _args) => {
  for (const clock of [...ctx.db.simClock.iter()]) {
    if (!clock.playing) continue;
    const d = ctx.db.dataset.datasetId.find(clock.datasetId);
    if (!d || d.status !== 'ready') continue;
    const total = clock.carrySec + clock.speed * (Number(TICK_MICROS) / 1e6);
    const steps = Math.floor(total / d.stepSec);
    const carry = total - steps * d.stepSec;
    if (steps === 0) {
      ctx.db.simClock.datasetId.update({ ...clock, carrySec: carry });
      continue;
    }
    const next = Math.min(d.tEnd, clock.nowUnix + steps * d.stepSec);
    ctx.db.simClock.datasetId.update({ ...clock, nowUnix: next, carrySec: carry, playing: next < d.tEnd });
    recompute(ctx, clock.datasetId);
  }
});

// ---------- events ----------
export const recomputeEvents = spacetimedb.reducer({ datasetId: t.string() }, (ctx, { datasetId }) => {
  requireReady(ctx, datasetId);
  recompute(ctx, datasetId);
});

export const injectFailure = spacetimedb.reducer(
  { datasetId: t.string(), facilityId: t.string(), levelPct: t.option(t.f64()), onsetUnix: t.option(t.u32()) },
  (ctx, { datasetId, facilityId, levelPct, onsetUnix }) => {
    const d = requireReady(ctx, datasetId);
    const { model, grid } = getData(ctx, datasetId);
    const fac = model.facilityById.get(facilityId);
    if (!fac) throw new SenderError(`unknown facility ${facilityId}`);
    const clock = ctx.db.simClock.datasetId.find(datasetId)!;
    const onset = snap(d, onsetUnix ?? clock.nowUnix);
    let level = levelPct;
    if (level == null) level = countdownAt(model, grid, facilityId, onset).levelPctRaw;
    if (!Number.isFinite(level) || level < 0 || level >= model.shutdownPct) throw new SenderError(`level must be in [0, ${model.shutdownPct})`);
    ctx.db.injectedFailure.insert({ id: 0n, datasetId, facilityId, onsetUnix: onset, levelPct: level, createdBy: ctx.sender, createdAt: ctx.timestamp });
    recompute(ctx, datasetId);
  },
);

/** Demo: every pump in a system fails at once (e.g. "what if the disposal site shuts down?"). */
export const injectSystemOutage = spacetimedb.reducer({ datasetId: t.string(), systemId: t.string() }, (ctx, { datasetId, systemId }) => {
  requireReady(ctx, datasetId);
  const { model, grid } = getData(ctx, datasetId);
  const sys = model.systemById.get(systemId);
  if (!sys) throw new SenderError(`unknown system ${systemId}`);
  const clock = ctx.db.simClock.datasetId.find(datasetId)!;
  for (const fid of sys.facilityIds) {
    const level = countdownAt(model, grid, fid, clock.nowUnix).levelPctRaw;
    if (!Number.isFinite(level) || level >= model.shutdownPct) continue;
    ctx.db.injectedFailure.insert({ id: 0n, datasetId, facilityId: fid, onsetUnix: clock.nowUnix, levelPct: level, createdBy: ctx.sender, createdAt: ctx.timestamp });
  }
  recompute(ctx, datasetId);
});

/** Fleet sizing: replay every pump failure detected up to the clock for fleet sizes 0..current+2. */
export const runFleetSweep = spacetimedb.reducer({ datasetId: t.string() }, (ctx, { datasetId }) => {
  requireReady(ctx, datasetId);
  const { model, grid } = getData(ctx, datasetId);
  const clock = ctx.db.simClock.datasetId.find(datasetId)!;
  const injected = [...ctx.db.injectedFailure.datasetId.filter(datasetId)].map((r) => ({ facilityId: r.facilityId, onsetUnix: r.onsetUnix, levelPct: r.levelPct }));
  const out = analyze({ model, grid, asOfUnix: clock.nowUnix, injected, skipPlans: true });
  const rows = fleetSweep(model, grid, out.events.filter((e) => e.source !== 'injected'), { asOfUnix: clock.nowUnix });
  for (const r of [...ctx.db.fleetSweep.datasetId.filter(datasetId)]) ctx.db.fleetSweep.key.delete(r.key);
  for (const r of rows)
    ctx.db.fleetSweep.insert({ key: `${datasetId}/${r.systemId}/${r.fleetSize}`, datasetId, ...r, asOfUnix: clock.nowUnix });
});

export const clearInjected = spacetimedb.reducer({ datasetId: t.string() }, (ctx, { datasetId }) => {
  requireDataset(ctx, datasetId);
  for (const r of [...ctx.db.injectedFailure.datasetId.filter(datasetId)]) ctx.db.injectedFailure.id.delete(r.id);
  recompute(ctx, datasetId);
});

// ---------- plans ----------
function toCoreOverrides(o: Record<string, any> | undefined | null): CorePlanOverrides | undefined {
  if (!o) return undefined;
  const r: CorePlanOverrides = {};
  if (o.fleetSize != null) r.fleetSize = o.fleetSize;
  if (o.repairHours != null) r.repairHours = o.repairHours;
  if (o.extraRepairHours != null) r.extraRepairHours = o.extraRepairHours;
  if (o.truckCapacityBbl != null) r.truckCapacityBbl = o.truckCapacityBbl;
  if (o.costPerTrip != null) r.costPerTrip = o.costPerTrip;
  if (o.lockedWells != null) r.lockedWells = o.lockedWells;
  if (o.noTrucks != null) r.noTrucks = o.noTrucks;
  return r;
}

/** Ongoing, not-yet-approved pump failures in a system, as planner inputs at the clock. */
function systemFailures(ctx: Ctx, datasetId: string, systemId: string, eventIds?: string[]) {
  const evs = [...ctx.db.event.datasetId.filter(datasetId)].filter(
    (e) => e.systemId === systemId && e.category === 'pump_failure' && e.status === 'ongoing' && (!eventIds || eventIds.includes(e.eventId)),
  );
  const committed = committedPlans(ctx, datasetId);
  const covered = new Set(committed.flatMap((c) => c.eventIds));
  const { model, grid } = getData(ctx, datasetId);
  const clock = ctx.db.simClock.datasetId.find(datasetId)!;
  const failures: FailureInput[] = [];
  const onsetByEvent: Record<string, number> = {};
  const levels = new Map<string, { levelPct: number; alreadyTripped: boolean; wellsOff: string[] }>();
  for (const e of evs) {
    if (covered.has(e.eventId)) continue;
    const fac = model.facilityById.get(e.facilityId)!;
    let levelPct = e.levelPct ?? NaN;
    let tripped = false;
    let wellsOff: string[] = [];
    if (e.source !== 'injected') {
      const cd = countdownAt(model, grid, e.facilityId, clock.nowUnix, { sinceUnix: e.onsetUnix });
      levelPct = cd.levelPct;
      tripped = cd.alreadyTripped;
      const prod = new Set(cd.producingWells);
      wellsOff = fac.wells.filter((w) => !prod.has(w.id)).map((w) => w.id);
    } else tripped = levelPct >= model.shutdownPct - 1e-9;
    failures.push({ eventId: e.eventId, facilityId: e.facilityId, levelPct, repairEndUnix: e.repairEndUnix ?? e.onsetUnix + model.repairHoursPumpFailure * 3600, alreadyTripped: tripped, wellsOff });
    onsetByEvent[e.eventId] = e.onsetUnix;
    levels.set(e.eventId, { levelPct, alreadyTripped: tripped, wellsOff });
  }
  const busy = committed.filter((c) => c.systemId === systemId && c.planStartUnix <= clock.nowUnix).flatMap((c) => c.truckFreeAtUnix);
  return { model, now: clock.nowUnix, failures, onsetByEvent, levels, busy };
}

/** Operator asks for a fresh optimal plan for a system, optionally with what-if overrides. */
export const computePlan = spacetimedb.reducer(
  { datasetId: t.string(), systemId: t.string(), overrides: t.option(PlanOverrides) },
  (ctx, { datasetId, systemId, overrides }) => {
    requireReady(ctx, datasetId);
    const s = systemFailures(ctx, datasetId, systemId);
    if (!s.failures.length) throw new SenderError(`no unplanned ongoing pump failures in ${systemId}`);
    const o = toCoreOverrides(overrides);
    const sp = planSystem({ model: s.model, systemId, nowUnix: s.now, failures: s.failures, overrides: o, busyTruckFreeAtUnix: s.busy, onsetUnixByEvent: s.onsetByEvent });
    writePlan(ctx, datasetId, sp, { origin: 'operator', status: 'proposed', rationale: overrides ? 'operator what-if' : '', overrides: o }, s.levels);
  },
);

/** What-if: run the planner with overrides; result rows link the what-if plan and the baseline. */
export const requestWhatif = spacetimedb.reducer(
  { datasetId: t.string(), systemId: t.string(), overrides: PlanOverrides, label: t.string() },
  (ctx, { datasetId, systemId, overrides, label }) => {
    requireReady(ctx, datasetId);
    const req = ctx.db.whatifRequest.insert({ requestId: 0n, datasetId, systemId, overrides, label, requestedBy: ctx.sender, createdAt: ctx.timestamp });
    try {
      const s = systemFailures(ctx, datasetId, systemId);
      if (!s.failures.length) throw new Error(`no unplanned ongoing pump failures in ${systemId}`);
      const o = toCoreOverrides(overrides);
      const base = planSystem({ model: s.model, systemId, nowUnix: s.now, failures: s.failures, busyTruckFreeAtUnix: s.busy });
      const alt = planSystem({ model: s.model, systemId, nowUnix: s.now, failures: s.failures, overrides: o, busyTruckFreeAtUnix: s.busy, onsetUnixByEvent: s.onsetByEvent });
      const basePlanId = writePlan(ctx, datasetId, base, { origin: 'whatif', status: 'proposed', rationale: `baseline for: ${label}` }, s.levels);
      const altPlanId = writePlan(ctx, datasetId, alt, { origin: 'whatif', status: 'proposed', rationale: label, overrides: o }, s.levels);
      ctx.db.whatifResult.insert({ requestId: req.requestId, datasetId, status: 'done', error: '', planId: altPlanId, baselinePlanId: basePlanId, totalCost: alt.totalCost, baselineCost: base.totalCost, deltaCost: alt.totalCost - base.totalCost });
    } catch (e) {
      ctx.db.whatifResult.insert({ requestId: req.requestId, datasetId, status: 'error', error: (e as Error).message, planId: undefined, baselinePlanId: undefined, totalCost: 0, baselineCost: 0, deltaCost: 0 });
    }
  },
);

function revalidate(ctx: Ctx, planId: bigint) {
  const p = ctx.db.plan.planId.find(planId);
  if (!p) throw new SenderError(`unknown plan ${planId}`);
  const { model } = getData(ctx, p.datasetId);
  const facs = [...ctx.db.planFacility.planId.filter(planId)];
  const acts = [...ctx.db.planAction.planId.filter(planId)];
  const failures: FailureInput[] = facs.map((f) => ({
    eventId: f.eventId, facilityId: f.facilityId, levelPct: f.levelAtStartPct, repairEndUnix: f.repairEndUnix,
    alreadyTripped: f.alreadyTripped, wellsOff: f.wellsOff,
  }));
  const actions: PlanAction[] = acts.map((a) => ({ type: a.type as PlanAction['type'], facilityId: a.facilityId, trucks: a.trucks, tripsPerTruck: a.tripsPerTruck, wells: a.wells, startAfterMin: a.startAfterMin }));
  const busy = committedPlans(ctx, p.datasetId, planId)
    .filter((c) => c.systemId === p.systemId && c.planStartUnix <= p.planStartUnix)
    .flatMap((c) => c.truckFreeAtUnix);
  const v = validatePlan({ model, systemId: p.systemId, nowUnix: p.planStartUnix, failures, actions, busyTruckFreeAtUnix: busy, overrides: toCoreOverrides(p.overrides) });
  return { p, v };
}

/** Human approval. The module re-validates the plan first (fleet, trip timing, tank volume). */
export const approvePlan = spacetimedb.reducer({ planId: t.u64() }, (ctx, { planId }) => {
  const { p, v } = revalidate(ctx, planId);
  if (p.status === 'approved') return;
  if (!v.valid) {
    ctx.db.plan.planId.update({ ...p, valid: false, validationErrors: v.errors });
    throw new SenderError(`plan ${planId} is not valid: ${v.errors.join('; ')}`);
  }
  // approving a what-if or agent plan for events that already have an approved plan is a conflict
  const others = committedPlans(ctx, p.datasetId).flatMap((c) => c.eventIds);
  const dup = p.eventIds.filter((id) => others.includes(id));
  if (dup.length) throw new SenderError(`events already have an approved plan: ${dup.join(', ')}`);
  ctx.db.plan.planId.update({ ...p, status: 'approved', valid: true, validationErrors: [], approvedBy: ctx.sender, approvedAt: ctx.timestamp });
  for (const o of [...ctx.db.plan.datasetId.filter(p.datasetId)]) {
    if (o.planId === planId || o.status !== 'proposed' || o.origin === 'planner') continue;
    if (o.eventIds.some((id) => p.eventIds.includes(id))) ctx.db.plan.planId.update({ ...o, status: 'superseded' });
  }
  recompute(ctx, p.datasetId);
});

export const rejectPlan = spacetimedb.reducer({ planId: t.u64(), reason: t.string() }, (ctx, { planId, reason }) => {
  const p = ctx.db.plan.planId.find(planId);
  if (!p) throw new SenderError(`unknown plan ${planId}`);
  if (p.status === 'approved') {
    // un-approve: trucks are released and events get re-planned
    ctx.db.plan.planId.update({ ...p, status: 'rejected', rationale: reason ? `${p.rationale} | rejected: ${reason}` : p.rationale });
    recompute(ctx, p.datasetId);
    return;
  }
  ctx.db.plan.planId.update({ ...p, status: 'rejected', rationale: reason ? `${p.rationale} | rejected: ${reason}` : p.rationale });
});

/** Remove what-if / rejected / superseded plans of a dataset (housekeeping). */
export const prunePlans = spacetimedb.reducer({ datasetId: t.string() }, (ctx, { datasetId }) => {
  for (const p of [...ctx.db.plan.datasetId.filter(datasetId)]) {
    if (p.status === 'rejected' || p.status === 'superseded' || p.origin === 'whatif') deletePlan(ctx, p.planId);
  }
});

// ---------- multiplayer ----------
export const claimEvent = spacetimedb.reducer({ eventId: t.string(), note: t.string() }, (ctx, { eventId, note }) => {
  const e = ctx.db.event.eventId.find(eventId);
  if (!e) throw new SenderError(`unknown event ${eventId}`);
  const cur = ctx.db.claim.eventId.find(eventId);
  if (cur && !cur.claimedBy.isEqual(ctx.sender)) throw new SenderError(`already claimed by ${cur.operatorName}`);
  const row = { eventId, datasetId: e.datasetId, claimedBy: ctx.sender, operatorName: operatorName(ctx, ctx.sender), note, claimedAt: ctx.timestamp };
  if (cur) ctx.db.claim.eventId.update(row);
  else ctx.db.claim.insert(row);
});

export const releaseEvent = spacetimedb.reducer({ eventId: t.string() }, (ctx, { eventId }) => {
  const cur = ctx.db.claim.eventId.find(eventId);
  if (!cur) return;
  if (!cur.claimedBy.isEqual(ctx.sender) && !isAdmin(ctx)) throw new SenderError(`claimed by ${cur.operatorName}`);
  ctx.db.claim.eventId.delete(eventId);
});

export const postHandoff = spacetimedb.reducer({ datasetId: t.string(), text: t.string() }, (ctx, { datasetId, text }) => {
  requireDataset(ctx, datasetId);
  const body = text.trim();
  if (!body) throw new SenderError('handoff text required');
  const clock = ctx.db.simClock.datasetId.find(datasetId);
  ctx.db.handoff.insert({ id: 0n, datasetId, author: ctx.sender, authorName: operatorName(ctx, ctx.sender), source: 'operator', text: body.slice(0, 8000), asOfUnix: clock?.nowUnix ?? 0, agentRunId: undefined, createdAt: ctx.timestamp });
});

/** Operators ask the agent in natural language; the agent worker answers via agent_answer. */
export const askAgent = spacetimedb.reducer({ datasetId: t.string(), text: t.string() }, (ctx, { datasetId, text }) => {
  requireDataset(ctx, datasetId);
  const q = text.trim();
  if (!q) throw new SenderError('question required');
  ctx.db.agentQuestion.insert({ id: 0n, datasetId, askedBy: ctx.sender, askerName: operatorName(ctx, ctx.sender), text: q.slice(0, 2000), status: 'pending', answer: '', runId: undefined, createdAt: ctx.timestamp, answeredAt: undefined });
});

// ---------- ML sidecar results (worker) ----------
export const mlPutProbs = spacetimedb.reducer(
  { datasetId: t.string(), modelVersion: t.string(), asOfUnix: t.u32(), computeMs: t.u32(), replace: t.bool(), chunks: t.array(SeriesChunk) },
  (ctx, a) => {
    requireAdmin(ctx);
    const d = requireReady(ctx, a.datasetId);
    if (a.replace) {
      for (const r of [...ctx.db.series.datasetId.filter(a.datasetId)]) if (r.metric.startsWith('ml_')) ctx.db.series.id.delete(r.id);
      const cur = ctx.db.mlStatus.datasetId.find(a.datasetId);
      if (cur) ctx.db.mlStatus.datasetId.update({ ...cur, ok: false });
    }
    for (const c of a.chunks) {
      if (!c.metric.startsWith('ml_')) throw new SenderError('ML series metrics must start with ml_');
      ctx.db.series.insert({ id: 0n, datasetId: a.datasetId, assetId: c.assetId, metric: c.metric, chunkIdx: c.chunkIdx, t0: c.t0, stepSec: d.stepSec, values: c.values });
    }
  },
);

/** Marks ML results complete (ok=true triggers recompute with ML) or reports a sidecar error. */
export const mlSetStatus = spacetimedb.reducer(
  { datasetId: t.string(), ok: t.bool(), modelVersion: t.string(), asOfUnix: t.u32(), computeMs: t.u32(), error: t.string() },
  (ctx, a) => {
    requireAdmin(ctx);
    requireDataset(ctx, a.datasetId);
    const row = { datasetId: a.datasetId, ok: a.ok, modelVersion: a.modelVersion, asOfUnix: a.asOfUnix, error: a.error, computeMs: a.computeMs, updatedAt: ctx.timestamp };
    if (ctx.db.mlStatus.datasetId.find(a.datasetId)) ctx.db.mlStatus.datasetId.update(row);
    else ctx.db.mlStatus.insert(row);
    if (!a.ok) for (const r of [...ctx.db.series.datasetId.filter(a.datasetId)]) if (r.metric.startsWith('ml_')) ctx.db.series.id.delete(r.id);
    dropCache(a.datasetId);
    recompute(ctx, a.datasetId);
  },
);

/** SHAP drivers from /explain for one event (replaces earlier SHAP rows). */
export const mlPutEvidence = spacetimedb.reducer({ eventId: t.string(), drivers: t.array(Driver) }, (ctx, { eventId, drivers }) => {
  requireAdmin(ctx);
  const e = ctx.db.event.eventId.find(eventId);
  if (!e) throw new SenderError(`unknown event ${eventId}`);
  for (const r of [...ctx.db.eventEvidence.eventId.filter(eventId)]) if (r.source === 'shap') ctx.db.eventEvidence.id.delete(r.id);
  drivers.slice(0, 3).forEach((dr, i) =>
    ctx.db.eventEvidence.insert({ id: 0n, eventId, datasetId: e.datasetId, rank: 100 + i + 1, text: dr.text, source: 'shap', feature: dr.feature, contribution: dr.contribution }),
  );
});

// ---------- agent worker (write-only, admin identities) ----------
export const agentRunStart = spacetimedb.reducer(
  { runId: t.string(), datasetId: t.string(), eventId: t.string(), trigger: t.string(), provider: t.string(), model: t.string(), questionId: t.option(t.u64()) },
  (ctx, a) => {
    requireAdmin(ctx);
    if (ctx.db.agentRun.runId.find(a.runId)) throw new SenderError(`run ${a.runId} exists`);
    ctx.db.agentRun.insert({ runId: a.runId, datasetId: a.datasetId, eventId: a.eventId, trigger: a.trigger, status: 'running', provider: a.provider, model: a.model, summary: '', error: '', planId: undefined, questionId: a.questionId, startedAt: ctx.timestamp, finishedAt: undefined, latencyMs: 0 });
  },
);

export const agentStepLog = spacetimedb.reducer(
  { runId: t.string(), seq: t.u32(), kind: t.string(), toolName: t.string(), argsJson: t.string(), resultSummary: t.string(), ok: t.bool(), latencyMs: t.u32() },
  (ctx, a) => {
    requireAdmin(ctx);
    if (!ctx.db.agentRun.runId.find(a.runId)) throw new SenderError(`unknown run ${a.runId}`);
    ctx.db.agentStep.insert({ id: 0n, runId: a.runId, seq: a.seq, kind: a.kind, toolName: a.toolName, argsJson: a.argsJson.slice(0, 4000), resultSummary: a.resultSummary.slice(0, 4000), ok: a.ok, latencyMs: a.latencyMs, createdAt: ctx.timestamp });
  },
);

export const agentRunFinish = spacetimedb.reducer(
  { runId: t.string(), status: t.string(), summary: t.string(), error: t.string(), latencyMs: t.u32(), planId: t.option(t.u64()) },
  (ctx, a) => {
    requireAdmin(ctx);
    const r = ctx.db.agentRun.runId.find(a.runId);
    if (!r) throw new SenderError(`unknown run ${a.runId}`);
    ctx.db.agentRun.runId.update({ ...r, status: a.status, summary: a.summary.slice(0, 8000), error: a.error, latencyMs: a.latencyMs, planId: a.planId ?? r.planId, finishedAt: ctx.timestamp });
  },
);

/** Agent proposes a plan (explicit actions). The module validates it; invalid plans are stored with errors. */
export const agentProposePlan = spacetimedb.reducer(
  { runId: t.string(), datasetId: t.string(), systemId: t.string(), actions: t.array(ActionInput), rationale: t.string() },
  (ctx, a) => {
    requireAdmin(ctx);
    requireReady(ctx, a.datasetId);
    const ids = [...new Set(a.actions.map((x) => x.eventId).filter(Boolean))];
    const s = systemFailures(ctx, a.datasetId, a.systemId, ids.length ? ids : undefined);
    if (!s.failures.length) throw new SenderError(`no unplanned ongoing pump failures in ${a.systemId}`);
    const actions: PlanAction[] = a.actions.map((x) => ({ type: x.type as PlanAction['type'], facilityId: x.facilityId, trucks: x.trucks, tripsPerTruck: x.tripsPerTruck, wells: x.wells, startAfterMin: x.startAfterMin }));
    const v = validatePlan({ model: s.model, systemId: a.systemId, nowUnix: s.now, failures: s.failures, actions, busyTruckFreeAtUnix: s.busy });
    // build a SystemPlan view from the validation simulation
    const facilities = v.facilities.map((fc) => {
      const fac = s.model.facilityById.get(fc.facilityId)!;
      const acts: PlanAction[] = actions.filter((x) => x.facilityId === fc.facilityId);
      const failure = s.failures.find((f) => f.facilityId === fc.facilityId)!;
      return {
        eventId: fc.eventId,
        facilityId: fc.facilityId,
        actions: acts.length ? acts : [{ type: 'none' as const, facilityId: fc.facilityId }],
        cost: fc.sim.totalCost,
        truckCost: fc.sim.truckCost,
        shutInCost: fc.sim.shutInCost,
        tripCost: fc.sim.tripCost,
        doNothingCost: NaN,
        tripsAtUnixIfNothing: null,
        tripsAtUnix: fc.sim.tripMin === null ? null : s.now + fc.sim.tripMin * 60,
        peakLevelPct: fc.sim.peakLevelPct,
        repairEndUnix: failure.repairEndUnix,
        trucks: fc.trucks,
        tripsPerTruck: fc.tripsPerTruck,
        shutInWells: fc.wells,
        shutInStartUnix: fc.wells.length ? s.now + fc.startAfterMin * 60 : null,
        truckArrivalsUnix: fc.sim.arrivalsMin.map((m) => s.now + m * 60),
        truckFreeAtUnix: fc.truckFreeAtUnix,
        levelTrace: { t0: s.now, stepSec: 300, values: [] as number[] },
        summary: acts.map((x) => x.type).join(' + ') || 'none',
      };
      void fac;
    });
    const sp = {
      systemId: a.systemId,
      nowUnix: s.now,
      fleetSize: s.model.systemById.get(a.systemId)!.fleetSize,
      trucksAvailable: v.trucksAvailable,
      totalCost: v.totalCost,
      doNothingCost: NaN,
      facilities: facilities as any,
      stats: { evaluated: 0, ms: 0 },
    };
    const planId = writePlan(ctx, a.datasetId, sp, { origin: 'agent', status: 'proposed', rationale: a.rationale.slice(0, 4000), agentRunId: a.runId, validation: v }, s.levels);
    const r = ctx.db.agentRun.runId.find(a.runId);
    if (r) ctx.db.agentRun.runId.update({ ...r, planId });
  },
);

/** Agent endorses an existing plan (e.g. the planner's) with its rationale, without copying it. */
export const agentEndorsePlan = spacetimedb.reducer({ runId: t.string(), planId: t.u64(), rationale: t.string() }, (ctx, a) => {
  requireAdmin(ctx);
  const p = ctx.db.plan.planId.find(a.planId);
  if (!p) throw new SenderError(`unknown plan ${a.planId}`);
  ctx.db.plan.planId.update({ ...p, rationale: a.rationale.slice(0, 4000), agentRunId: a.runId });
  const r = ctx.db.agentRun.runId.find(a.runId);
  if (r) ctx.db.agentRun.runId.update({ ...r, planId: a.planId });
});

export const agentPostHandoff = spacetimedb.reducer({ runId: t.string(), datasetId: t.string(), text: t.string() }, (ctx, a) => {
  requireAdmin(ctx);
  const clock = ctx.db.simClock.datasetId.find(a.datasetId);
  ctx.db.handoff.insert({ id: 0n, datasetId: a.datasetId, author: ctx.sender, authorName: operatorName(ctx, ctx.sender), source: 'agent', text: a.text.slice(0, 8000), asOfUnix: clock?.nowUnix ?? 0, agentRunId: a.runId, createdAt: ctx.timestamp });
});

export const agentAnswer = spacetimedb.reducer({ runId: t.string(), questionId: t.u64(), answer: t.string(), ok: t.bool() }, (ctx, a) => {
  requireAdmin(ctx);
  const q = ctx.db.agentQuestion.id.find(a.questionId);
  if (!q) throw new SenderError(`unknown question ${a.questionId}`);
  ctx.db.agentQuestion.id.update({ ...q, status: a.ok ? 'answered' : 'failed', answer: a.answer.slice(0, 8000), runId: a.runId, answeredAt: ctx.timestamp });
});

export const agentDispatchMessage = spacetimedb.reducer(
  { runId: t.string(), datasetId: t.string(), planId: t.option(t.u64()), eventId: t.string(), recipient: t.string(), text: t.string() },
  (ctx, a) => {
    requireAdmin(ctx);
    ctx.db.dispatchMessage.insert({ id: 0n, datasetId: a.datasetId, planId: a.planId, eventId: a.eventId, recipient: a.recipient, text: a.text.slice(0, 4000), agentRunId: a.runId, createdAt: ctx.timestamp });
  },
);

// keep helper referenced (event id helper is part of the public contract in docs/API.md)
void fullId;
