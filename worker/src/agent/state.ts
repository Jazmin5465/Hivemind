// What the agent reads (a structural subset of the module's public rows) and writes
// (the agent_* reducers). StdbBackend wraps a live connection; tests use a fake.
import type { DatasetModel } from '../../../core/src/model';
import type { Grid } from '../../../core/src/telemetry';

export interface DatasetRow { datasetId: string; source: string; status: string; active: boolean; loadVersion: number; tStart: number; tEnd: number; stepSec: number }
export interface ClockRow { datasetId: string; nowUnix: number; playing: boolean; speed: number }
export interface EventRow {
  eventId: string; datasetId: string; systemId: string; facilityId: string; assetId: string;
  category: string; status: string; onsetUnix: number; endUnix?: number; confidence: number; source: string;
  hoursToLimitP50?: number; hoursToLimitP10?: number; hoursToLimitP90?: number; levelPct?: number;
  tripsAtUnix?: number; repairEndUnix?: number; lostRevenuePerHour: number; alertRank: number; action: string; planId?: bigint;
}
export interface EvidenceRow { eventId: string; rank: number; text: string; source: string }
export interface PlanRow {
  planId: bigint; datasetId: string; systemId: string; eventIds: string[]; origin: string; status: string;
  planStartUnix: number; totalCost: number; doNothingCost: number; summary: string; valid: boolean; agentRunId?: string;
}
export interface PlanActionRow { planId: bigint; eventId: string; facilityId: string; type: string; trucks: number; tripsPerTruck: number; wells: string[]; startAfterMin: number }
export interface PlanFacilityRow { planId: bigint; eventId: string; facilityId: string; truckFreeAtUnix: number[]; cost: number }
export interface QuestionRow { id: bigint; datasetId: string; askerName: string; text: string; status: string }
export interface RunRow { runId: string; datasetId: string; eventId: string; trigger: string; status: string }
export interface ClaimRow { eventId: string; operatorName: string; note: string }

export interface AgentState {
  datasets: DatasetRow[];
  clocks: ClockRow[];
  events: EventRow[];
  evidence: EvidenceRow[];
  plans: PlanRow[];
  planActions: PlanActionRow[];
  planFacilities: PlanFacilityRow[];
  questions: QuestionRow[];
  runs: RunRow[];
  claims: ClaimRow[];
}

export interface ActionIn { eventId: string; facilityId: string; type: string; trucks: number; tripsPerTruck: number; wells: string[]; startAfterMin: number }

export interface AgentBackend {
  state(): AgentState;
  loadData(ds: DatasetRow): { model: DatasetModel; grid: Grid };
  runStart(a: { runId: string; datasetId: string; eventId: string; trigger: string; provider: string; model: string; questionId?: bigint }): Promise<void>;
  stepLog(a: { runId: string; seq: number; kind: string; toolName: string; argsJson: string; resultSummary: string; ok: boolean; latencyMs: number }): Promise<void>;
  runFinish(a: { runId: string; status: string; summary: string; error: string; latencyMs: number; planId?: bigint }): Promise<void>;
  proposePlan(a: { runId: string; datasetId: string; systemId: string; actions: ActionIn[]; rationale: string }): Promise<void>;
  endorsePlan(a: { runId: string; planId: bigint; rationale: string }): Promise<void>;
  postHandoff(a: { runId: string; datasetId: string; text: string }): Promise<void>;
  answer(a: { runId: string; questionId: bigint; answer: string; ok: boolean }): Promise<void>;
  dispatchMessage(a: { runId: string; datasetId: string; planId?: bigint; eventId: string; recipient: string; text: string }): Promise<void>;
}
