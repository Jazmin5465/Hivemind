// Agent tools. Every number the agent may say comes from these results (collected into the
// run's FactSet for the verifier). Each call is logged as an agent_step.
import { planSystem, type PlanOverrides, type SystemPlan } from '../../../core/src/planner';
import { validatePlan, type ValidateResult } from '../../../core/src/validate';
import type { PlanAction } from '../../../core/src/types';
import { collectFacts, factsFromText, FactSet } from '../../../core/src/verifier';
import { busyTrucks, coveredEventIds, datasetCtx, hhmm, systemFailures, usd, type DatasetCtx } from './context';
import type { AgentBackend, ActionIn } from './state';
import type { ToolSpec } from './llm';

export class Trace {
  seq = 0;
  facts = new FactSet();
  constructor(readonly backend: AgentBackend, readonly runId: string) {}
  async step(kind: string, toolName: string, args: unknown, resultSummary: string, ok: boolean, latencyMs: number) {
    try {
      await this.backend.stepLog({
        runId: this.runId, seq: ++this.seq, kind, toolName, argsJson: safeJson(args).slice(0, 4000),
        resultSummary: resultSummary.slice(0, 4000), ok, latencyMs: Math.max(0, Math.round(latencyMs)),
      });
    } catch (e) {
      console.warn(`[agent] step log failed: ${(e as Error).message}`);
    }
  }
}

export function safeJson(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? Number(x) : x)) ?? '';
}

export interface PlanSummary {
  ref: string;
  systemId: string;
  label: string;
  overrides: PlanOverrides | null;
  totalCost: number;
  doNothingCost: number;
  savings: number;
  fleetSize: number;
  trucksAvailable: number;
  facilities: {
    eventId: string; facilityId: string; summary: string; cost: number; doNothingCost: number;
    tripsAtUnix: number | null; tripsAtIfNothing: string; tripsAtUnixIfNothing: number | null;
    repairEndUnix: number; repairEnd: string; peakLevelPct: number; truckArrivalsUnix: number[]; truckArrivals: string[];
    shutInWells: string[]; shutInStartUnix: number | null; shutInAt: string | null; trucks: number; tripsPerTruck: number;
    actions: PlanAction[];
  }[];
}

function summarizePlan(ref: string, label: string, sp: SystemPlan, overrides: PlanOverrides | null): PlanSummary {
  return {
    ref, label, systemId: sp.systemId, overrides,
    totalCost: round2(sp.totalCost), doNothingCost: round2(sp.doNothingCost), savings: round2(sp.doNothingCost - sp.totalCost),
    fleetSize: sp.fleetSize, trucksAvailable: sp.trucksAvailable,
    facilities: sp.facilities.map((f) => ({
      eventId: f.eventId, facilityId: f.facilityId, summary: f.summary, cost: round2(f.cost), doNothingCost: round2(f.doNothingCost),
      tripsAtUnix: f.tripsAtUnix == null ? null : Math.round(f.tripsAtUnix),
      tripsAtUnixIfNothing: f.tripsAtUnixIfNothing == null ? null : Math.round(f.tripsAtUnixIfNothing),
      tripsAtIfNothing: f.tripsAtUnixIfNothing == null ? 'never' : `${hhmm(f.tripsAtUnixIfNothing)} UTC`,
      repairEndUnix: Math.round(f.repairEndUnix), repairEnd: `${hhmm(f.repairEndUnix)} UTC`,
      peakLevelPct: Math.round(f.peakLevelPct * 10) / 10,
      truckArrivalsUnix: f.truckArrivalsUnix.map(Math.round), truckArrivals: f.truckArrivalsUnix.map((u) => `${hhmm(u)} UTC`),
      shutInWells: f.shutInWells, shutInStartUnix: f.shutInStartUnix == null ? null : Math.round(f.shutInStartUnix),
      shutInAt: f.shutInStartUnix == null ? null : `${hhmm(f.shutInStartUnix)} UTC`, trucks: f.trucks, tripsPerTruck: f.tripsPerTruck,
      actions: f.actions,
    })),
  };
}
const round2 = (x: number) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : x);

export interface ToolEnv {
  backend: AgentBackend;
  datasetId: string;
  trace: Trace;
}

/** Stateful toolbox for one run. */
export class ToolBox {
  plans = new Map<string, PlanSummary & { raw: SystemPlan }>();
  proposed: { systemId: string; planRef?: string; planId?: bigint; endorsed: boolean } | null = null;
  private n = 0;
  constructor(readonly env: ToolEnv) {}

  ctx(): DatasetCtx {
    return datasetCtx(this.env.backend, this.env.datasetId);
  }

  static specs(): ToolSpec[] {
    const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required });
    const overrides = {
      type: 'object',
      description: 'what-if changes',
      properties: {
        fleetSize: { type: 'integer', description: 'trucks in the system fleet' },
        extraRepairHours: { type: 'number', description: 'repair takes this many hours longer' },
        repairHours: { type: 'number', description: 'total repair hours from onset' },
        lockedWells: { type: 'array', items: { type: 'string' }, description: 'wells that must stay on' },
        noTrucks: { type: 'boolean' },
        truckCapacityBbl: { type: 'number' },
        costPerTrip: { type: 'number' },
      },
    };
    return [
      fn('get_event_context', 'Details of one event: category, facility, tank level, countdown, repair end, evidence, claim.', obj({ eventId: { type: 'string' } }, ['eventId'])),
      fn('get_system_state', 'A system: fleet, busy trucks, ongoing events and the current plan.', obj({ systemId: { type: 'string' } }, ['systemId'])),
      fn('plan_system', 'Run the exact cost optimizer for all ongoing pump failures in a system, optionally with what-if overrides. Returns a plan ref like P3.', obj({ systemId: { type: 'string' }, overrides, label: { type: 'string' } }, ['systemId'])),
      fn('simulate_tank', 'Simulate one facility under a manual plan (trucks x trips, wells shut in from startAfterMin). Returns validity, cost and peak level.', obj({ facilityId: { type: 'string' }, trucks: { type: 'integer' }, tripsPerTruck: { type: 'integer' }, wells: { type: 'array', items: { type: 'string' } }, startAfterMin: { type: 'integer' } }, ['facilityId'])),
      fn('compare_plans', 'Compare two plan refs from plan_system.', obj({ a: { type: 'string' }, b: { type: 'string' } }, ['a', 'b'])),
      fn('propose_plan', 'Propose a plan ref for operator approval (validated first).', obj({ systemId: { type: 'string' }, planRef: { type: 'string' }, rationale: { type: 'string' } }, ['systemId', 'planRef', 'rationale'])),
      fn('draft_handoff', 'Structured facts for a shift handoff of the active dataset.', obj({})),
    ];
  }

  async call(name: string, args: Record<string, any>): Promise<unknown> {
    const t0 = Date.now();
    try {
      const res = await this.dispatch(name, args ?? {});
      this.env.trace.facts.merge(collectFacts(res));
      this.env.trace.facts.merge(factsFromText(...quotedTexts(res)));
      await this.env.trace.step('tool', name, args, oneLine(res), true, Date.now() - t0);
      return res;
    } catch (e) {
      const msg = (e as Error).message;
      await this.env.trace.step('tool', name, args, `error: ${msg}`, false, Date.now() - t0);
      return { error: msg };
    }
  }

  private async dispatch(name: string, a: Record<string, any>): Promise<unknown> {
    switch (name) {
      case 'get_event_context': return this.getEventContext(String(a.eventId));
      case 'get_system_state': return this.getSystemState(String(a.systemId));
      case 'plan_system': return this.planSystemTool(String(a.systemId), cleanOverrides(a.overrides), a.label ? String(a.label) : undefined);
      case 'simulate_tank': return this.simulateTank(a);
      case 'compare_plans': return this.comparePlans(String(a.a), String(a.b));
      case 'propose_plan': return this.proposePlan(String(a.systemId), String(a.planRef), String(a.rationale ?? ''));
      case 'draft_handoff': return this.draftHandoff();
      default: throw new Error(`unknown tool ${name}`);
    }
  }

  getEventContext(eventId: string) {
    const c = this.ctx();
    const e = c.events.find((x) => x.eventId === eventId);
    if (!e) throw new Error(`unknown event ${eventId}`);
    const fac = c.model.facilityById.get(e.facilityId);
    const claim = c.state.claims.find((x) => x.eventId === eventId);
    const evidence = c.state.evidence.filter((x) => x.eventId === eventId).sort((x, y) => x.rank - y.rank).map((x) => x.text);
    return {
      eventId, category: e.category, status: e.status, systemId: e.systemId, facilityId: e.facilityId, assetId: e.assetId,
      onsetUnix: e.onsetUnix, onset: `${hhmm(e.onsetUnix)} UTC`, nowUnix: c.nowUnix, now: `${hhmm(c.nowUnix)} UTC`,
      confidencePct: Math.round(e.confidence * 100), source: e.source, alertRank: e.alertRank,
      levelPct: e.levelPct == null ? null : Math.round(e.levelPct * 10) / 10,
      shutdownPct: c.model.shutdownPct, warningPct: c.model.warningPct,
      hoursToLimitP50: e.hoursToLimitP50 == null ? null : round2(e.hoursToLimitP50),
      hoursToLimitP10: e.hoursToLimitP10 == null ? null : round2(e.hoursToLimitP10),
      hoursToLimitP90: e.hoursToLimitP90 == null ? null : round2(e.hoursToLimitP90),
      tripsAtUnix: e.tripsAtUnix ?? null, tripsAt: e.tripsAtUnix ? `${hhmm(e.tripsAtUnix)} UTC` : null,
      repairEndUnix: e.repairEndUnix ?? null, repairEnd: e.repairEndUnix ? `${hhmm(e.repairEndUnix)} UTC` : null,
      repairRemainingHours: e.repairEndUnix ? round2(Math.max(0, e.repairEndUnix - c.nowUnix) / 3600) : null,
      lostRevenuePerHour: round2(e.lostRevenuePerHour),
      capacityBbl: fac?.capacityBbl, inflowBpd: fac?.baselineInflowBpd,
      responseMin: fac?.responseMin, cycleMin: fac?.cycleMin,
      wells: fac?.wells.map((w) => ({ id: w.id, waterBpd: w.baselineWaterBpd, revenuePerHour: round2(w.revenuePerHour) })),
      evidence, claimedBy: claim?.operatorName ?? null,
      action: e.action,
    };
  }

  getSystemState(systemId: string) {
    const c = this.ctx();
    const sys = c.model.systemById.get(systemId);
    if (!sys) throw new Error(`unknown system ${systemId}`);
    const busy = busyTrucks(c, systemId);
    const covered = coveredEventIds(c);
    const evs = c.events.filter((e) => e.systemId === systemId && e.status === 'ongoing');
    const plans = c.state.plans.filter((p) => p.datasetId === c.ds.datasetId && p.systemId === systemId && (p.status === 'approved' || (p.status === 'proposed' && p.origin === 'planner')));
    return {
      systemId, ongoingCount: evs.length, failureCount: evs.filter((e) => e.category === 'pump_failure').length,
      fleetSize: sys.fleetSize, trucksBusy: busy.length, trucksFree: Math.max(0, sys.fleetSize - busy.length),
      trucksFreeAt: busy.map((t) => `${hhmm(t)} UTC`), truckCapacityBbl: c.model.truckCapacityBbl, costPerTrip: c.model.costPerTrip,
      ongoing: evs.map((e) => ({ eventId: e.eventId, category: e.category, facilityId: e.facilityId, hoursToLimitP50: e.hoursToLimitP50 == null ? null : round2(e.hoursToLimitP50), approved: covered.has(e.eventId) })),
      plans: plans.map((p) => ({ planId: Number(p.planId), origin: p.origin, status: p.status, totalCost: round2(p.totalCost), doNothingCost: round2(p.doNothingCost), summary: p.summary })),
    };
  }

  planSystemTool(systemId: string, overrides: PlanOverrides | null, label?: string): PlanSummary {
    const c = this.ctx();
    const { failures, onsetByEvent } = systemFailures(c, systemId);
    if (!failures.length) throw new Error(`no unplanned ongoing pump failures in ${systemId}`);
    const sp = planSystem({ model: c.model, systemId, nowUnix: c.nowUnix, failures, overrides: overrides ?? undefined, busyTruckFreeAtUnix: busyTrucks(c, systemId), onsetUnixByEvent: onsetByEvent });
    const ref = `P${++this.n}`;
    const s = summarizePlan(ref, label ?? (overrides ? describeOverrides(overrides, c.model.systemById.get(systemId)?.fleetSize) : 'baseline'), sp, overrides);
    this.plans.set(ref, { ...s, raw: sp });
    return s;
  }

  simulateTank(a: Record<string, any>) {
    const c = this.ctx();
    const facilityId = String(a.facilityId);
    const fac = c.model.facilityById.get(facilityId);
    if (!fac) throw new Error(`unknown facility ${facilityId}`);
    const { failures } = systemFailures(c, fac.systemId);
    const f = failures.find((x) => x.facilityId === facilityId);
    if (!f) throw new Error(`${facilityId} has no unplanned ongoing pump failure`);
    const actions: PlanAction[] = [];
    if ((a.trucks ?? 0) > 0) actions.push({ type: 'dispatch_truck', facilityId, trucks: Number(a.trucks), tripsPerTruck: Number(a.tripsPerTruck ?? 1) });
    if (Array.isArray(a.wells) && a.wells.length) actions.push({ type: 'shut_in_wells', facilityId, wells: a.wells.map(String), startAfterMin: Number(a.startAfterMin ?? 0) });
    const v = validatePlan({ model: c.model, systemId: fac.systemId, nowUnix: c.nowUnix, failures: [f], actions, busyTruckFreeAtUnix: busyTrucks(c, fac.systemId) });
    const fc = v.facilities[0];
    return {
      facilityId, valid: v.valid, errors: v.errors, cost: round2(v.totalCost),
      tripsAtUnix: fc?.sim.tripMin == null ? null : Math.round(c.nowUnix + fc.sim.tripMin * 60),
      peakLevelPct: fc ? Math.round(fc.sim.peakLevelPct * 10) / 10 : null,
      truckArrivals: fc ? fc.sim.arrivalsMin.map((m) => `${hhmm(c.nowUnix + m * 60)} UTC`) : [],
    };
  }

  comparePlans(a: string, b: string) {
    const pa = this.plans.get(a);
    const pb = this.plans.get(b);
    if (!pa || !pb) throw new Error(`unknown plan ref ${!pa ? a : b}`);
    return {
      a: { ref: a, label: pa.label, totalCost: pa.totalCost }, b: { ref: b, label: pb.label, totalCost: pb.totalCost },
      deltaCost: round2(pb.totalCost - pa.totalCost),
      changes: pb.facilities.map((f) => {
        const o = pa.facilities.find((x) => x.facilityId === f.facilityId);
        return { facilityId: f.facilityId, before: o?.summary ?? '-', after: f.summary, deltaCost: round2(f.cost - (o?.cost ?? 0)) };
      }).filter((x) => x.before !== x.after || x.deltaCost !== 0),
    };
  }

  /** Critic + propose. Validates with the module's rules first; endorses the planner's plan if identical. */
  async proposePlan(systemId: string, planRef: string, rationale: string) {
    const p = this.plans.get(planRef);
    if (!p) throw new Error(`unknown plan ref ${planRef}`);
    if (p.overrides) throw new Error(`${planRef} is a what-if (${p.label}); propose a baseline plan`);
    const crit = this.critic(systemId, p.raw);
    if (!crit.valid) return { proposed: false, errors: crit.errors };
    const c = this.ctx();
    const planner = c.state.plans.find((x) => x.datasetId === c.ds.datasetId && x.systemId === systemId && x.origin === 'planner' && x.status === 'proposed');
    const runId = this.env.trace.runId;
    if (planner && sameActions(c, planner.planId, p.raw)) {
      await this.env.backend.endorsePlan({ runId, planId: planner.planId, rationale });
      this.proposed = { systemId, planRef, planId: planner.planId, endorsed: true };
      return { proposed: true, endorsedPlanId: Number(planner.planId) };
    }
    const actions: ActionIn[] = p.raw.facilities.flatMap((f) =>
      f.actions.filter((x) => x.type !== 'none').map((x) => ({
        eventId: f.eventId, facilityId: f.facilityId, type: x.type, trucks: x.trucks ?? 0, tripsPerTruck: x.tripsPerTruck ?? 0,
        wells: x.wells ?? [], startAfterMin: Math.round(x.startAfterMin ?? 0),
      })),
    );
    if (!actions.length) {
      // a "do nothing" plan: endorse the planner's (also none) if present
      if (planner) {
        await this.env.backend.endorsePlan({ runId, planId: planner.planId, rationale });
        this.proposed = { systemId, planRef, planId: planner.planId, endorsed: true };
        return { proposed: true, endorsedPlanId: Number(planner.planId) };
      }
      return { proposed: false, errors: ['nothing to propose (no actions)'] };
    }
    await this.env.backend.proposePlan({ runId, datasetId: c.ds.datasetId, systemId, actions, rationale });
    this.proposed = { systemId, planRef, endorsed: false };
    return { proposed: true, newPlan: true };
  }

  /** Re-validate a plan against fleet limits, trip timing and tank volume (same rules as the module). */
  critic(systemId: string, sp: SystemPlan): ValidateResult {
    const c = this.ctx();
    const { failures } = systemFailures(c, systemId);
    const actions = sp.facilities.flatMap((f) => f.actions.map((a) => ({ ...a, eventId: f.eventId })));
    const v = validatePlan({ model: c.model, systemId, nowUnix: c.nowUnix, failures, actions, busyTruckFreeAtUnix: busyTrucks(c, systemId) });
    // also flag a plan that ignores a failure the planner sees now
    for (const f of failures) if (!sp.facilities.some((x) => x.eventId === f.eventId)) v.errors.push(`plan does not cover ${f.eventId}`);
    // fleet conflicts with other systems can't happen (fleets are per system), but trucks on approved plans can
    v.valid = v.errors.length === 0;
    return v;
  }

  draftHandoff() {
    const c = this.ctx();
    const ongoing = c.events.filter((e) => e.status === 'ongoing').sort((a, b) => a.alertRank - b.alertRank);
    const recent = c.events.filter((e) => e.status === 'resolved' && e.endUnix != null && e.endUnix > c.nowUnix - 12 * 3600);
    const plans = c.state.plans.filter((p) => p.datasetId === c.ds.datasetId);
    const items = ongoing.map((e) => {
      const p = e.planId != null ? plans.find((x) => x.planId === e.planId) : undefined;
      const claim = c.state.claims.find((x) => x.eventId === e.eventId);
      return {
        eventId: e.eventId, alertRank: e.alertRank, category: e.category, facilityId: e.facilityId, assetId: e.assetId,
        since: `${hhmm(e.onsetUnix)} UTC`, onsetUnix: e.onsetUnix,
        hoursToLimitP50: e.hoursToLimitP50 == null ? null : round2(e.hoursToLimitP50),
        levelPct: e.levelPct == null ? null : Math.round(e.levelPct * 10) / 10,
        repairEnd: e.repairEndUnix ? `${hhmm(e.repairEndUnix)} UTC` : null, repairEndUnix: e.repairEndUnix ?? null,
        plan: p ? { planId: Number(p.planId), status: p.status, totalCost: round2(p.totalCost), summary: p.summary } : null,
        owner: claim?.operatorName ?? null,
      };
    });
    return {
      datasetId: c.ds.datasetId, nowUnix: c.nowUnix, now: `${hhmm(c.nowUnix)} UTC`, ongoingCount: ongoing.length,
      ongoing: items, resolvedLast12hCount: recent.length,
      resolvedLast12h: recent.map((e) => ({ category: e.category, assetId: e.assetId, endUnix: e.endUnix, ended: `${hhmm(e.endUnix)} UTC` })),
    };
  }
}

function fn(name: string, description: string, parameters: Record<string, unknown>): ToolSpec {
  return { type: 'function', function: { name, description, parameters } };
}

function cleanOverrides(o: unknown): PlanOverrides | null {
  if (!o || typeof o !== 'object') return null;
  const s = o as Record<string, any>;
  const r: PlanOverrides = {};
  if (Number.isFinite(Number(s.fleetSize)) && s.fleetSize != null) r.fleetSize = Math.max(0, Math.round(Number(s.fleetSize)));
  if (Number.isFinite(Number(s.extraRepairHours)) && s.extraRepairHours != null) r.extraRepairHours = Number(s.extraRepairHours);
  if (Number.isFinite(Number(s.repairHours)) && s.repairHours != null) r.repairHours = Number(s.repairHours);
  if (Number.isFinite(Number(s.truckCapacityBbl)) && s.truckCapacityBbl != null) r.truckCapacityBbl = Number(s.truckCapacityBbl);
  if (Number.isFinite(Number(s.costPerTrip)) && s.costPerTrip != null) r.costPerTrip = Number(s.costPerTrip);
  if (Array.isArray(s.lockedWells)) r.lockedWells = s.lockedWells.map(String);
  if (s.noTrucks === true) r.noTrucks = true;
  return Object.keys(r).length ? r : null;
}

export function describeOverrides(o: PlanOverrides, fleet?: number): string {
  const parts: string[] = [];
  if (o.fleetSize != null) parts.push(fleet != null && o.fleetSize < fleet ? `fleet cut to ${o.fleetSize} truck${o.fleetSize === 1 ? '' : 's'}` : `fleet of ${o.fleetSize} truck${o.fleetSize === 1 ? '' : 's'}`);
  if (o.extraRepairHours) parts.push(`repair ${o.extraRepairHours} h longer`);
  if (o.repairHours != null) parts.push(`repair takes ${o.repairHours} h`);
  if (o.noTrucks) parts.push('no trucks');
  if (o.lockedWells?.length) parts.push(`keep ${o.lockedWells.join(', ')} on`);
  if (o.truckCapacityBbl != null) parts.push(`${o.truckCapacityBbl} bbl per truckload`);
  if (o.costPerTrip != null) parts.push(`${usd(o.costPerTrip)} per trip`);
  return parts.join(', ') || 'baseline';
}

function sameActions(c: DatasetCtx, planId: bigint, sp: SystemPlan): boolean {
  const mine = sp.facilities.flatMap((f) => f.actions.filter((a) => a.type !== 'none').map((a) => key(f.facilityId, a.type, a.trucks ?? 0, a.tripsPerTruck ?? 0, a.wells ?? [], a.startAfterMin ?? 0))).sort();
  const theirs = c.state.planActions.filter((a) => a.planId === planId && a.type !== 'none').map((a) => key(a.facilityId, a.type, a.trucks, a.tripsPerTruck, a.wells, a.startAfterMin)).sort();
  return mine.length === theirs.length && mine.every((x, i) => x === theirs[i]);
}
const key = (f: string, t: string, k: number, n: number, w: string[], s: number) =>
  `${f}|${t}|${t === 'dispatch_truck' ? `${k}x${n}` : ''}|${t === 'shut_in_wells' ? `${[...w].sort().join(',')}@${Math.round(s)}` : ''}`;

/** strings in tool results that may be quoted verbatim (evidence, plan summaries, labels) */
function quotedTexts(v: unknown, depth = 0, out: string[] = []): string[] {
  if (depth > 6 || v == null) return out;
  if (typeof v === 'string') {
    out.push(v);
    return out;
  }
  if (Array.isArray(v)) for (const x of v) quotedTexts(x, depth + 1, out);
  else if (typeof v === 'object') for (const x of Object.values(v as object)) quotedTexts(x, depth + 1, out);
  return out;
}

function oneLine(v: unknown): string {
  const s = safeJson(v);
  return s.length > 600 ? `${s.slice(0, 600)}…` : s;
}
