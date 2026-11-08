// AgentBackend over a live SpacetimeDB connection (subscriptions = agent's view of the module).
import type { DbConnection } from '../module_bindings';
import { loadFolder } from '../folder';
import type { DatasetModel } from '../../../core/src/model';
import type { Grid } from '../../../core/src/telemetry';
import type { AgentBackend, AgentState, DatasetRow } from './state';

export const AGENT_SUBSCRIPTIONS = [
  'SELECT * FROM dataset',
  'SELECT * FROM sim_clock',
  'SELECT * FROM event',
  'SELECT * FROM event_evidence',
  'SELECT * FROM plan',
  'SELECT * FROM plan_action',
  'SELECT * FROM plan_facility',
  'SELECT * FROM agent_question',
  'SELECT * FROM agent_run',
  'SELECT * FROM claim',
];

export class StdbBackend implements AgentBackend {
  private cache = new Map<string, { key: string; model: DatasetModel; grid: Grid }>();
  constructor(readonly conn: DbConnection) {}

  state(): AgentState {
    const db = this.conn.db;
    return {
      datasets: [...db.dataset.iter()],
      clocks: [...db.simClock.iter()],
      events: [...db.event.iter()],
      evidence: [...db.eventEvidence.iter()],
      plans: [...db.plan.iter()],
      planActions: [...db.planAction.iter()],
      planFacilities: [...db.planFacility.iter()],
      questions: [...db.agentQuestion.iter()],
      runs: [...db.agentRun.iter()],
      claims: [...db.claim.iter()],
    };
  }

  loadData(ds: DatasetRow) {
    const key = `${ds.loadVersion}|${ds.source}`;
    const hit = this.cache.get(ds.datasetId);
    if (hit && hit.key === key) return hit;
    // the module stores the folder path it was loaded from; the worker runs on the same machine
    const d = loadFolder(ds.source, ds.datasetId);
    const entry = { key, model: d.model, grid: d.grid };
    this.cache.set(ds.datasetId, entry);
    return entry;
  }

  runStart(a: Parameters<AgentBackend['runStart']>[0]) {
    return this.conn.reducers.agentRunStart({ ...a, questionId: a.questionId });
  }
  stepLog(a: Parameters<AgentBackend['stepLog']>[0]) {
    return this.conn.reducers.agentStepLog(a);
  }
  runFinish(a: Parameters<AgentBackend['runFinish']>[0]) {
    return this.conn.reducers.agentRunFinish({ ...a, planId: a.planId });
  }
  proposePlan(a: Parameters<AgentBackend['proposePlan']>[0]) {
    return this.conn.reducers.agentProposePlan(a);
  }
  endorsePlan(a: Parameters<AgentBackend['endorsePlan']>[0]) {
    return this.conn.reducers.agentEndorsePlan(a);
  }
  postHandoff(a: Parameters<AgentBackend['postHandoff']>[0]) {
    return this.conn.reducers.agentPostHandoff(a);
  }
  answer(a: Parameters<AgentBackend['answer']>[0]) {
    return this.conn.reducers.agentAnswer(a);
  }
  dispatchMessage(a: Parameters<AgentBackend['dispatchMessage']>[0]) {
    return this.conn.reducers.agentDispatchMessage({ ...a, planId: a.planId });
  }
}
