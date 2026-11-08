// End-to-end agent run logic with a fake backend and LLM_PROVIDER=template (no network).
import { describe, expect, it } from 'vitest';
import { event9Model } from './fixtures';
import { AgentRunner, parseQuestion, splitSections } from '../../worker/src/agent/runner';
import { Scheduler } from '../../worker/src/agent/scheduler';
import { LlmClient, llmConfigFromEnv } from '../../worker/src/agent/llm';
import type { AgentBackend, AgentState, EventRow } from '../../worker/src/agent/state';

const ONSET = 1_791_418_800; // 00:20 UTC
const DS = 'fix';

function fakeBackend(extraEvents: EventRow[] = []) {
  const model = event9Model();
  const grid = { t0: ONSET - 3600, stepSec: 300, n: 1, series: new Map() };
  const fail: EventRow = {
    eventId: `${DS}:pump_failure:PUMP_C:${ONSET}`, datasetId: DS, systemId: 'SX', facilityId: 'FAC_C', assetId: 'PUMP_C',
    category: 'pump_failure', status: 'ongoing', onsetUnix: ONSET, confidence: 1, source: 'injected',
    hoursToLimitP50: 4.48, hoursToLimitP10: 4.03, hoursToLimitP90: 4.93, levelPct: 50, tripsAtUnix: ONSET + 16128,
    repairEndUnix: ONSET + 6 * 3600, lostRevenuePerHour: 3300, alertRank: 1, action: 'plan', planId: 7n,
  };
  const state: AgentState = {
    datasets: [{ datasetId: DS, source: '/nowhere', status: 'ready', active: true, loadVersion: 1, tStart: ONSET - 3600, tEnd: ONSET, stepSec: 300 }],
    clocks: [{ datasetId: DS, nowUnix: ONSET, playing: false, speed: 300 }],
    events: [fail, ...extraEvents],
    evidence: [],
    plans: [{ planId: 7n, datasetId: DS, systemId: 'SX', eventIds: [fail.eventId], origin: 'planner', status: 'proposed', planStartUnix: ONSET, totalCost: 905, doNothingCost: 5016, summary: 'FAC_C: 1 truck, 1 trip', valid: true }],
    planActions: [{ planId: 7n, eventId: fail.eventId, facilityId: 'FAC_C', type: 'dispatch_truck', trucks: 1, tripsPerTruck: 1, wells: [], startAfterMin: 0 }],
    planFacilities: [{ planId: 7n, eventId: fail.eventId, facilityId: 'FAC_C', truckFreeAtUnix: [ONSET + 305 * 60], cost: 905 }],
    questions: [],
    runs: [],
    claims: [],
  };
  const calls: { name: string; args: any }[] = [];
  const rec = (name: string) => async (args: any) => {
    calls.push({ name, args });
    if (name === 'runStart') state.runs.push({ runId: args.runId, datasetId: args.datasetId, eventId: args.eventId, trigger: args.trigger, status: 'running' });
  };
  const backend: AgentBackend = {
    state: () => state,
    loadData: () => ({ model, grid }),
    runStart: rec('runStart'), stepLog: rec('stepLog'), runFinish: rec('runFinish'), proposePlan: rec('proposePlan'),
    endorsePlan: rec('endorsePlan'), postHandoff: rec('postHandoff'), answer: rec('answer'), dispatchMessage: rec('dispatchMessage'),
  };
  return { backend, state, calls, fail };
}

const templateLlm = () => new LlmClient(llmConfigFromEnv({ LLM_PROVIDER: 'template' }));

describe('agent runner (template provider)', () => {
  it('pump failure: diagnose, plan, what-ifs, critic, endorse, verified texts', async () => {
    const { backend, calls, fail } = fakeBackend();
    const r = await new AgentRunner(backend, templateLlm()).runSystem(DS, 'SX', [fail.eventId], 'event_new');
    expect(r.status).toBe('done');
    expect(r.latencyMs).toBeLessThan(20_000);
    const steps = calls.filter((c) => c.name === 'stepLog').map((c) => `${c.args.kind}:${c.args.toolName}`);
    expect(steps).toEqual(expect.arrayContaining(['tool:get_event_context', 'tool:get_system_state', 'tool:plan_system', 'tool:compare_plans', 'critic:validate_plan', 'tool:propose_plan', 'fallback:template']));
    expect(calls.find((c) => c.name === 'endorsePlan')?.args.planId).toBe(7n); // same as the module's planner plan
    expect(calls.some((c) => c.name === 'proposePlan')).toBe(false);
    const fb = calls.find((c) => c.name === 'stepLog' && c.args.kind === 'fallback');
    expect(fb?.args.resultSummary).toContain('numbers verified');
    expect(r.summary).toContain('$905');
    expect(r.summary).toContain('$5,016');
    const dm = calls.filter((c) => c.name === 'dispatchMessage');
    expect(dm.length).toBe(1);
    expect(dm[0].args.text).toMatch(/send 1 truck to FAC_C/);
    expect(calls.find((c) => c.name === 'runFinish')?.args.status).toBe('done');
  });

  it('leak: inspection run with dispatch to the inspector', async () => {
    const leak: EventRow = { eventId: `${DS}:pipeline_leak:PIPE_C:${ONSET}`, datasetId: DS, systemId: 'SX', facilityId: 'FAC_C', assetId: 'PIPE_C', category: 'pipeline_leak', status: 'ongoing', onsetUnix: ONSET, confidence: 0.79, source: 'rules', lostRevenuePerHour: 3300, alertRank: 2, action: 'field_inspection' };
    const { backend, calls, state } = fakeBackend([leak]);
    state.evidence.push({ eventId: leak.eventId, rank: 1, text: 'Water reaching the disposal site is 93.8% of what the pump sends (last 2.0 h of pumping)', source: 'rules' });
    const r = await new AgentRunner(backend, templateLlm()).runInspection(DS, leak.eventId, 'event_new');
    expect(r.status).toBe('done');
    expect(r.summary).toMatch(/inspector/);
    expect(r.summary).toContain('93.8%');
    expect(calls.find((c) => c.name === 'dispatchMessage')?.args.recipient).toBe('field inspector');
    const fb = calls.find((c) => c.name === 'stepLog' && c.args.kind === 'fallback');
    expect(fb?.args.resultSummary).toContain('numbers verified');
  });

  it('questions become planner calls', async () => {
    const { backend, calls } = fakeBackend();
    const runner = new AgentRunner(backend, templateLlm());
    const r = await runner.answerQuestion({ id: 3n, datasetId: DS, askerName: 'ana', text: 'What if we have no trucks?', status: 'pending' });
    expect(r.status).toBe('done');
    expect(r.summary).toMatch(/W_C2/);
    expect(r.summary).toContain('$1,958');
    expect(calls.find((c) => c.name === 'answer')?.args.ok).toBe(true);
    const h = await runner.answerQuestion({ id: 4n, datasetId: DS, askerName: 'ana', text: 'write the shift handoff', status: 'pending' });
    expect(h.summary).toMatch(/Shift handoff/);
    expect(calls.some((c) => c.name === 'postHandoff')).toBe(true);
  });

  it('handoff run posts a short plain-English note', async () => {
    const { backend, calls } = fakeBackend();
    const r = await new AgentRunner(backend, templateLlm()).handoff(DS);
    expect(r.status).toBe('done');
    expect(r.summary.split(/\s+/).length).toBeLessThan(120);
    expect(calls.find((c) => c.name === 'postHandoff')?.args.text).toBe(r.summary);
  });

  it('a broken event or dataset does not crash the loop', async () => {
    const { backend, calls } = fakeBackend();
    const r = await new AgentRunner(backend, templateLlm()).runSystem(DS, 'NOPE', ['missing'], 'event_new');
    expect(['done', 'failed']).toContain(r.status);
    expect(calls.filter((c) => c.name === 'runFinish').length).toBe(1);
    const broken = { ...backend, loadData: () => { throw new Error('folder gone'); } };
    const r2 = await new AgentRunner(broken, templateLlm()).runSystem(DS, 'SX', ['x'], 'event_new');
    expect(['done', 'failed']).toContain(r2.status);
  });

  it('LLM down falls back to templates', async () => {
    const { backend, calls, fail } = fakeBackend();
    const llm = new LlmClient(llmConfigFromEnv({ LLM_PROVIDER: 'brev', LLM_BASE_URL: 'http://127.0.0.1:9/v1', LLM_MODEL: 'x', LLM_TIMEOUT_MS: '500' }));
    const r = await new AgentRunner(backend, llm).runSystem(DS, 'SX', [fail.eventId], 'event_new');
    expect(r.status).toBe('done');
    expect(r.textSource).toBe('template');
    expect(calls.some((c) => c.name === 'stepLog' && c.args.kind === 'llm' && !c.args.ok)).toBe(true);
  });

  it('scheduler triggers one joint run per system without anyone typing', async () => {
    const { backend, calls } = fakeBackend();
    const sched = new Scheduler(backend, new AgentRunner(backend, templateLlm()), { debounceMs: 10 });
    sched.scan();
    sched.scan(); // debounced
    await new Promise((r) => setTimeout(r, 50));
    await sched.idle();
    expect(calls.filter((c) => c.name === 'runStart').length).toBe(1);
    sched.scan(); // already processed
    await new Promise((r) => setTimeout(r, 30));
    await sched.idle();
    expect(calls.filter((c) => c.name === 'runStart').length).toBe(1);
    sched.stop();
  });
});

describe('question parsing and sections', () => {
  const systems = [{ id: 'S2', fleet: 2, facilityIds: ['S2_FACILITY_A'] }, { id: 'S4', fleet: 3, facilityIds: [] }];
  it('maps phrases to overrides', () => {
    expect(parseQuestion('what if we lose a truck in S2?', systems, []).overrides('S2')).toEqual({ fleetSize: 1 });
    expect(parseQuestion('what if the repair is 2 hours longer', systems, []).overrides('S4')).toEqual({ extraRepairHours: 2 });
    expect(parseQuestion('we only have one truck', systems, []).overrides('S4')).toEqual({ fleetSize: 1 });
    expect(parseQuestion('keep S2_WELL_A1 on please, what then?', systems, ['S2_WELL_A1']).overrides('S2')).toEqual({ lockedWells: ['S2_WELL_A1'] });
    expect(parseQuestion('handoff please', systems, []).kind).toBe('handoff');
    expect(parseQuestion('what is going on?', systems, []).kind).toBe('status');
    expect(parseQuestion('status of S2_FACILITY_A', systems, []).systemIds).toEqual(['S2']);
  });
  it('splits SUMMARY/DISPATCH', () => {
    const s = splitSections('SUMMARY: tank fills.\nDISPATCH:\n- 2 trucks to A\n1. shut in W1');
    expect(s.summary).toBe('tank fills.');
    expect(s.dispatch).toEqual(['2 trucks to A', 'shut in W1']);
  });
});
