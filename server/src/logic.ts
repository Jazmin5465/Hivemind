// Module-side glue: build the core model/grid from tables, run the core pipeline, write results.
import { SenderError, type InferSchema, type ReducerCtx } from 'spacetimedb/server';
import type { Identity } from 'spacetimedb';
import spacetimedb from './schema';
import { buildModel, type DatasetModel } from '../../core/src/model';
import type { Grid } from '../../core/src/telemetry';
import { analyze, facilitySnapshot, type AnalyzeOutput, type CommittedPlan } from '../../core/src/analyze';
import type { FacilityPlan, PlanOverrides, SystemPlan } from '../../core/src/planner';
import type { ValidateResult } from '../../core/src/validate';
import { longTermAdvice, temporaryAdvice, watchList } from '../../core/src/fleetAdvice';

export type Ctx = ReducerCtx<InferSchema<typeof spacetimedb>>;

export const CHUNK_STEPS = 288; // one day of 5-minute steps per series row

export function nowMs(): number {
  try {
    return typeof Date !== 'undefined' && typeof Date.now === 'function' ? Date.now() : 0;
  } catch {
    return 0;
  }
}

// ---------- auth ----------
export function isAdmin(ctx: Ctx): boolean {
  return ctx.db.admin.identity.find(ctx.sender) != null;
}
export function requireAdmin(ctx: Ctx) {
  if (!isAdmin(ctx)) throw new SenderError('only the module owner or a registered worker can do this');
}

export function operatorName(ctx: Ctx, who: Identity): string {
  return ctx.db.operator.identity.find(who)?.name ?? `op-${who.toHexString().slice(0, 6)}`;
}

// ---------- dataset access ----------
export function requireDataset(ctx: Ctx, datasetId: string) {
  const d = ctx.db.dataset.datasetId.find(datasetId);
  if (!d) throw new SenderError(`unknown dataset ${datasetId}`);
  return d;
}
export function requireReady(ctx: Ctx, datasetId: string) {
  const d = requireDataset(ctx, datasetId);
  if (d.status !== 'ready') throw new SenderError(`dataset ${datasetId} is ${d.status}`);
  return d;
}

interface CacheEntry {
  key: string;
  model: DatasetModel;
  grid: Grid;
  mlVersion: string;
}
// Read-only cache of immutable series data, keyed by load version + ML version.
// Safe across transactions because it is fully rebuilt whenever either version changes.
const cache = new Map<string, CacheEntry>();

export function getModel(ctx: Ctx, datasetId: string): DatasetModel {
  const raw = ctx.db.datasetRaw.datasetId.find(datasetId);
  if (!raw) throw new SenderError(`dataset ${datasetId} has no network/ops`);
  return buildModel(JSON.parse(raw.networkJson), JSON.parse(raw.opsJson));
}

export function getData(ctx: Ctx, datasetId: string): CacheEntry {
  const d = requireReady(ctx, datasetId);
  const ml = ctx.db.mlStatus.datasetId.find(datasetId);
  const mlVersion = ml && ml.ok ? `${ml.modelVersion}@${ml.updatedAt.microsSinceUnixEpoch}` : '';
  const key = `${d.loadVersion}|${mlVersion}`;
  const hit = cache.get(datasetId);
  if (hit && hit.key === key) return hit;
  const model = getModel(ctx, datasetId);
  const series = new Map<string, Float64Array>();
  for (const row of ctx.db.series.datasetId.filter(datasetId)) {
    if (!mlVersion && row.metric.startsWith('ml_')) continue;
    const k = `${row.assetId}|${row.metric}`;
    let a = series.get(k);
    if (!a) {
      a = new Float64Array(d.nSteps).fill(NaN);
      series.set(k, a);
    }
    const off = Math.round((row.t0 - d.tStart) / d.stepSec);
    const vals = row.values;
    for (let i = 0; i < vals.length; i++) {
      const j = off + i;
      if (j >= 0 && j < a.length) a[j] = vals[i];
    }
  }
  const entry = { key, model, grid: { t0: d.tStart, stepSec: d.stepSec, n: d.nSteps, series }, mlVersion };
  cache.set(datasetId, entry);
  return entry;
}

export function dropCache(datasetId: string) {
  cache.delete(datasetId);
}

// ---------- plans ----------
export function committedPlans(ctx: Ctx, datasetId: string, excludePlanId?: bigint): CommittedPlan[] {
  const out: CommittedPlan[] = [];
  for (const p of ctx.db.plan.datasetId.filter(datasetId)) {
    if (p.status !== 'approved' || p.planId === excludePlanId || p.scenarioFacilityId) continue;
    const free: number[] = [];
    for (const pf of ctx.db.planFacility.planId.filter(p.planId)) free.push(...pf.truckFreeAtUnix);
    // core/analyze uses event keys without the dataset prefix
    const prefix = `${datasetId}:`;
    const keys = p.eventIds.map((id) => (id.startsWith(prefix) ? id.slice(prefix.length) : id));
    out.push({ systemId: p.systemId, eventIds: [...p.eventIds, ...keys], planStartUnix: p.planStartUnix, truckFreeAtUnix: free });
  }
  return out;
}

function optU32(v: number | null | undefined): number | undefined {
  return v == null || !Number.isFinite(v) ? undefined : Math.max(0, Math.round(v));
}
function optF64(v: number | null | undefined): number | undefined {
  return v == null || !Number.isFinite(v) ? undefined : v;
}

function deletePlanChildren(ctx: Ctx, planId: bigint) {
  for (const a of [...ctx.db.planAction.planId.filter(planId)]) ctx.db.planAction.id.delete(a.id);
  for (const f of [...ctx.db.planFacility.planId.filter(planId)]) ctx.db.planFacility.id.delete(f.id);
}

export function deletePlan(ctx: Ctx, planId: bigint) {
  deletePlanChildren(ctx, planId);
  ctx.db.plan.planId.delete(planId);
}

export interface PlanMeta {
  origin: string;
  status: string;
  rationale: string;
  overrides?: PlanOverrides;
  agentRunId?: string;
  validation?: ValidateResult;
  optionKey?: string;
  scenarioFacilityId?: string;
}

function overridesToRow(o?: PlanOverrides) {
  if (!o) return undefined;
  return {
    fleetSize: o.fleetSize,
    repairHours: o.repairHours,
    extraRepairHours: o.extraRepairHours,
    truckCapacityBbl: o.truckCapacityBbl,
    costPerTrip: o.costPerTrip,
    lockedWells: o.lockedWells,
    noTrucks: o.noTrucks,
  };
}

/** Insert (or replace in place when existingPlanId is given) a plan and its children. */
export function writePlan(
  ctx: Ctx,
  datasetId: string,
  sp: SystemPlan,
  meta: PlanMeta,
  levelsAtStart: Map<string, { levelPct: number; alreadyTripped: boolean; wellsOff: string[] }>,
  existingPlanId?: bigint,
): bigint {
  const errors = meta.validation ? meta.validation.errors : [];
  const row = {
    datasetId,
    systemId: sp.systemId,
    eventIds: sp.facilities.map((f) => f.eventId),
    origin: meta.origin,
    status: meta.status,
    planStartUnix: Math.round(sp.nowUnix),
    totalCost: sp.totalCost,
    doNothingCost: sp.doNothingCost,
    fleetSize: sp.fleetSize,
    trucksAvailable: sp.trucksAvailable,
    valid: errors.length === 0,
    validationErrors: errors,
    summary: sp.facilities.map((f) => `${f.facilityId}: ${f.summary}`).join('; '),
    rationale: meta.rationale,
    overrides: overridesToRow(meta.overrides),
    createdBy: ctx.sender,
    createdAt: ctx.timestamp,
    approvedBy: undefined,
    approvedAt: undefined,
    agentRunId: meta.agentRunId,
    searchMs: Math.round(sp.stats.ms),
    optionKey: meta.optionKey ?? '',
    scenarioFacilityId: meta.scenarioFacilityId ?? '',
  };
  let planId: bigint;
  if (existingPlanId != null && ctx.db.plan.planId.find(existingPlanId)) {
    planId = existingPlanId;
    deletePlanChildren(ctx, planId);
    ctx.db.plan.planId.update({ ...row, planId });
  } else {
    planId = ctx.db.plan.insert({ ...row, planId: 0n }).planId;
  }
  for (const f of sp.facilities) writeFacility(ctx, datasetId, planId, f, levelsAtStart.get(f.eventId));
  return planId;
}

function writeFacility(
  ctx: Ctx,
  datasetId: string,
  planId: bigint,
  f: FacilityPlan,
  start?: { levelPct: number; alreadyTripped: boolean; wellsOff: string[] },
) {
  for (const a of f.actions) {
    ctx.db.planAction.insert({
      id: 0n,
      planId,
      datasetId,
      eventId: f.eventId,
      facilityId: a.facilityId ?? f.facilityId,
      type: a.type,
      trucks: a.trucks ?? 0,
      tripsPerTruck: a.tripsPerTruck ?? 0,
      wells: a.wells ?? [],
      startAfterMin: Math.max(0, Math.round(a.startAfterMin ?? 0)),
      assetId: a.assetId ?? '',
    });
  }
  ctx.db.planFacility.insert({
    id: 0n,
    planId,
    eventId: f.eventId,
    facilityId: f.facilityId,
    cost: f.cost,
    truckCost: f.truckCost,
    shutInCost: f.shutInCost,
    tripCost: f.tripCost,
    doNothingCost: f.doNothingCost,
    tripsAtUnix: optU32(f.tripsAtUnix),
    tripsAtUnixIfNothing: optU32(f.tripsAtUnixIfNothing),
    peakLevelPct: f.peakLevelPct,
    repairEndUnix: Math.round(f.repairEndUnix),
    levelAtStartPct: start?.levelPct ?? NaN,
    alreadyTripped: start?.alreadyTripped ?? false,
    wellsOff: start?.wellsOff ?? [],
    truckArrivalsUnix: f.truckArrivalsUnix.map((x) => Math.round(x)),
    truckFreeAtUnix: f.truckFreeAtUnix.map((x) => Math.round(x)),
    traceT0: Math.round(f.levelTrace.t0),
    traceStepSec: f.levelTrace.stepSec,
    levelTrace: f.levelTrace.values,
    summary: f.summary,
    latestDispatchUnix: f.latestDispatchUnix != null && Number.isFinite(f.latestDispatchUnix) ? Math.round(f.latestDispatchUnix) : 0,
  });
}

// ---------- recompute ----------
export function recompute(ctx: Ctx, datasetId: string): AnalyzeOutput | null {
  const d = ctx.db.dataset.datasetId.find(datasetId);
  if (!d || d.status !== 'ready') return null;
  const clock = ctx.db.simClock.datasetId.find(datasetId);
  if (!clock) return null;
  const t0 = nowMs();
  const { model, grid, mlVersion } = getData(ctx, datasetId);
  const now = clock.nowUnix;
  const injected = [...ctx.db.injectedFailure.datasetId.filter(datasetId)].map((r) => ({
    facilityId: r.facilityId,
    onsetUnix: r.onsetUnix,
    levelPct: r.levelPct,
  }));
  const committed = committedPlans(ctx, datasetId);
  const out = analyze({
    model,
    grid,
    asOfUnix: now,
    detector: 'auto',
    injected,
    committed,
    mlModelVersion: mlVersion.split('@')[0] || undefined,
  });

  // --- events (upsert by stable id, delete stale) ---
  const existing = new Map([...ctx.db.event.datasetId.filter(datasetId)].map((e) => [e.eventId, e]));
  const seen = new Set<string>();
  const approvedByEvent = new Map<string, bigint>();
  for (const p of ctx.db.plan.datasetId.filter(datasetId)) {
    if (p.status === 'approved' && p.planStartUnix <= now) for (const id of p.eventIds) approvedByEvent.set(id, p.planId);
  }

  // --- planner plans: one per system, replaced in place ---
  const plannerPlans = new Map<string, bigint>();
  for (const p of ctx.db.plan.datasetId.filter(datasetId)) {
    if (p.origin === 'planner' && p.status === 'proposed') plannerPlans.set(p.systemId, p.planId);
  }
  const planByEvent = new Map<string, bigint>();
  const keepPlanner = new Set<string>();
  for (const sp of out.plans) {
    const levels = new Map<string, { levelPct: number; alreadyTripped: boolean; wellsOff: string[] }>();
    // FailureInput lives in analyze(); recover levels from events
    for (const f of sp.facilities) {
      const ev = out.events.find((e) => fullId(datasetId, e.eventId) === fullId(datasetId, f.eventId) || e.eventId === f.eventId);
      const fac = model.facilityById.get(f.facilityId)!;
      const producing = new Set(ev?.countdown?.producingWells ?? fac.wells.map((w) => w.id));
      levels.set(fullId(datasetId, f.eventId), {
        levelPct: ev?.countdown?.levelPct ?? NaN,
        alreadyTripped: ev?.countdown?.alreadyTripped ?? false,
        wellsOff: fac.wells.filter((w) => !producing.has(w.id)).map((w) => w.id),
      });
    }
    const spFull: SystemPlan = { ...sp, facilities: sp.facilities.map((f) => ({ ...f, eventId: fullId(datasetId, f.eventId) })) };
    const planId = writePlan(ctx, datasetId, spFull, { origin: 'planner', status: 'proposed', rationale: '' }, levels, plannerPlans.get(sp.systemId));
    keepPlanner.add(sp.systemId);
    for (const f of spFull.facilities) planByEvent.set(f.eventId, planId);
  }
  for (const [sys, pid] of plannerPlans) if (!keepPlanner.has(sys)) deletePlan(ctx, pid);

  for (const e of out.events) {
    const id = fullId(datasetId, e.eventId);
    seen.add(id);
    const cd = e.countdown;
    const row = {
      eventId: id,
      datasetId,
      systemId: e.systemId,
      facilityId: e.facilityId,
      assetId: e.assetId,
      category: e.category,
      status: e.status,
      onsetUnix: Math.round(e.onsetUnix),
      endUnix: optU32(e.endUnix),
      confidence: e.confidence,
      source: e.source,
      hoursToLimitP50: optF64(cd?.hoursToLimitP50),
      hoursToLimitP10: optF64(cd?.hoursToLimitP10),
      hoursToLimitP90: optF64(cd?.hoursToLimitP90),
      levelPct: optF64(cd?.levelPct),
      tripsAtUnix: optU32(cd?.tripsAtUnix),
      repairEndUnix: optU32(e.repairEndUnix),
      lostRevenuePerHour: e.lostRevenuePerHour,
      alertRank: e.alertRank,
      action: e.action,
      planId: approvedByEvent.get(id) ?? planByEvent.get(id),
      asOfUnix: now,
    };
    if (existing.has(id)) ctx.db.event.eventId.update(row);
    else ctx.db.event.insert(row);
    writeDetectorEvidence(ctx, datasetId, id, e.source === 'ml' ? 'ml' : e.source, e.evidence);
  }
  for (const [id] of existing) {
    if (seen.has(id)) continue;
    ctx.db.event.eventId.delete(id);
    for (const ev of [...ctx.db.eventEvidence.eventId.filter(id)]) ctx.db.eventEvidence.id.delete(ev.id);
  }

  // --- facility state for the map ---
  const alertFacilities = new Set(out.events.filter((e) => e.status === 'ongoing').map((e) => e.facilityId));
  const snapshot = facilitySnapshot(model, grid, now);
  const failing = new Set(out.events.filter((e) => e.status === 'ongoing' && e.category === 'pump_failure').map((e) => e.facilityId));
  const watch = watchList(model, snapshot, failing);
  const watchRank = new Map(watch.map((w, i) => [w.facilityId, { rank: i + 1, hours: w.hours }]));
  for (const s of snapshot) {
    const key = `${datasetId}/${s.facilityId}`;
    const row = {
      key,
      datasetId,
      facilityId: s.facilityId,
      systemId: s.systemId,
      asOfUnix: now,
      levelPct: s.levelPct,
      inflowBpd: s.inflowBpd,
      pumpStatus: s.pumpStatus,
      pumpFlowBpd: s.pumpFlowBpd,
      dischargePsi: s.dischargePsi,
      receiveFlowBpd: s.receiveFlowBpd,
      pipelinePressurePsi: s.pipelinePressurePsi,
      wellsProducing: s.wellsProducing,
      wellsTotal: s.wellsTotal,
      health: alertFacilities.has(s.facilityId) ? 'alert' : s.levelPct >= model.warningPct ? 'warning' : 'ok',
      wellIds: s.wellIds,
      wellStatus: s.wellStatus,
      wellWaterBpd: s.wellWaterBpd,
      watchHours: watchRank.get(s.facilityId)?.hours ?? -1,
      watchRank: watchRank.get(s.facilityId)?.rank ?? 0,
    };
    if (ctx.db.facilityState.key.find(key)) ctx.db.facilityState.key.update(row);
    else ctx.db.facilityState.insert(row);
  }

  writeFleetAdvice(ctx, datasetId, model, now);
  if (d.detector !== out.detectorUsed) ctx.db.dataset.datasetId.update({ ...d, detector: out.detectorUsed });
  const ms = Math.max(0, Math.round(nowMs() - t0));
  ctx.db.simClock.datasetId.update({ ...clock, computedForUnix: now, computeMs: ms });
  if (out.detectorError) console.warn(`[${datasetId}] ${out.detectorError}`);
  return out;
}

export const fullId = (datasetId: string, eventKey: string) =>
  eventKey.startsWith(`${datasetId}:`) ? eventKey : `${datasetId}:${eventKey}`;

/** Replace detector evidence (rules/ml/injected) when its text changed; keep SHAP rows from the worker. */
function writeDetectorEvidence(ctx: Ctx, datasetId: string, eventId: string, source: string, texts: string[]) {
  const rows = [...ctx.db.eventEvidence.eventId.filter(eventId)].filter((r) => r.source !== 'shap');
  const same = rows.length === texts.length && rows.every((r) => texts[r.rank - 1] === r.text && r.source === source);
  if (same) return;
  for (const r of rows) ctx.db.eventEvidence.id.delete(r.id);
  texts.forEach((text, i) =>
    ctx.db.eventEvidence.insert({ id: 0n, eventId, datasetId, rank: i + 1, text, source, feature: '', contribution: 0 }),
  );
}

// ---------- deletion helpers ----------
export function deleteDatasetRows(ctx: Ctx, datasetId: string, keepClockAndCollab: boolean) {
  const delAll = <T>(rows: Iterable<T>, del: (r: T) => void) => {
    for (const r of [...rows]) del(r);
  };
  delAll(ctx.db.series.datasetId.filter(datasetId), (r) => ctx.db.series.id.delete(r.id));
  delAll(ctx.db.system.datasetId.filter(datasetId), (r) => ctx.db.system.key.delete(r.key));
  delAll(ctx.db.facility.datasetId.filter(datasetId), (r) => ctx.db.facility.key.delete(r.key));
  delAll(ctx.db.well.datasetId.filter(datasetId), (r) => ctx.db.well.key.delete(r.key));
  delAll(ctx.db.opsSystem.datasetId.filter(datasetId), (r) => ctx.db.opsSystem.key.delete(r.key));
  delAll(ctx.db.opsFacility.datasetId.filter(datasetId), (r) => ctx.db.opsFacility.key.delete(r.key));
  delAll(ctx.db.facilityState.datasetId.filter(datasetId), (r) => ctx.db.facilityState.key.delete(r.key));
  delAll(ctx.db.event.datasetId.filter(datasetId), (r) => ctx.db.event.eventId.delete(r.eventId));
  delAll(ctx.db.eventEvidence.datasetId.filter(datasetId), (r) => ctx.db.eventEvidence.id.delete(r.id));
  delAll(ctx.db.plan.datasetId.filter(datasetId), (r) => deletePlan(ctx, r.planId));
  delAll(ctx.db.decision.datasetId.filter(datasetId), (r) => ctx.db.decision.id.delete(r.id));
  delAll(ctx.db.whatifRequest.datasetId.filter(datasetId), (r) => ctx.db.whatifRequest.requestId.delete(r.requestId));
  delAll(ctx.db.whatifResult.datasetId.filter(datasetId), (r) => ctx.db.whatifResult.requestId.delete(r.requestId));
  delAll(ctx.db.injectedFailure.datasetId.filter(datasetId), (r) => ctx.db.injectedFailure.id.delete(r.id));
  delAll(ctx.db.fleetSweep.datasetId.filter(datasetId), (r) => ctx.db.fleetSweep.key.delete(r.key));
  delAll(ctx.db.fleetRecommendation.datasetId.filter(datasetId), (r) => ctx.db.fleetRecommendation.key.delete(r.key));
  delAll(ctx.db.fixOption.datasetId.filter(datasetId), (r) => ctx.db.fixOption.key.delete(r.key));
  ctx.db.opsConfig.datasetId.delete(datasetId);
  ctx.db.datasetRaw.datasetId.delete(datasetId);
  ctx.db.mlStatus.datasetId.delete(datasetId);
  if (!keepClockAndCollab) {
    ctx.db.simClock.datasetId.delete(datasetId);
    delAll(ctx.db.claim.datasetId.filter(datasetId), (r) => ctx.db.claim.eventId.delete(r.eventId));
  }
  dropCache(datasetId);
}

/** Temporary borrowing (trucks free at the clock) + the long-term move (from fleet_sweep). Rewrites only on change. */
export function writeFleetAdvice(ctx: Ctx, datasetId: string, model: DatasetModel, now: number) {
  const busy = new Map<string, number>();
  for (const c of committedPlans(ctx, datasetId)) {
    if (c.planStartUnix > now) continue;
    busy.set(c.systemId, (busy.get(c.systemId) ?? 0) + c.truckFreeAtUnix.filter((t) => t > now).length);
  }
  const standby = new Map(model.systems.map((s) => [s.id, Math.max(0, s.fleetSize - (busy.get(s.id) ?? 0))]));
  const sweep = [...ctx.db.fleetSweep.datasetId.filter(datasetId)];
  const advice = [...temporaryAdvice(model, standby)];
  const lt = longTermAdvice(model, sweep);
  if (lt) advice.push(lt);
  const want = new Map(advice.map((a) => [`${datasetId}/${a.kind}/${a.fromSystem}/${a.toSystem}`, a]));
  const have = [...ctx.db.fleetRecommendation.datasetId.filter(datasetId)];
  for (const r of have) {
    const w = want.get(r.key);
    if (!w) ctx.db.fleetRecommendation.key.delete(r.key);
    else if (w.reason !== r.reason) ctx.db.fleetRecommendation.key.update({ ...r, reason: w.reason, km: w.km, savings: w.savings, asOfUnix: now });
  }
  for (const [key, a] of want) {
    if (have.some((r) => r.key === key)) continue;
    ctx.db.fleetRecommendation.insert({ key, datasetId, kind: a.kind, fromSystem: a.fromSystem, toSystem: a.toSystem, km: Number.isFinite(a.km) ? a.km : 0, reason: a.reason, savings: a.savings, asOfUnix: now });
  }
}
