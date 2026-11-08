// Hivemind SpacetimeDB schema. Everything is keyed by datasetId (the folder name) so several
// datasets coexist and the live app can flip between them. Times are unix seconds (u32).
// Public tables are the frontend API: see docs/API.md. Private tables are marked.
import { schema, table, t } from 'spacetimedb/server';

// ---------- shared object types ----------
export const SeriesChunk = t.object('SeriesChunk', {
  assetId: t.string(),
  metric: t.string(),
  chunkIdx: t.u32(),
  t0: t.u32(),
  values: t.array(t.f64()),
});

export const PlanOverrides = t.object('PlanOverrides', {
  fleetSize: t.option(t.u32()),
  repairHours: t.option(t.f64()),
  extraRepairHours: t.option(t.f64()),
  truckCapacityBbl: t.option(t.f64()),
  costPerTrip: t.option(t.f64()),
  lockedWells: t.option(t.array(t.string())),
  noTrucks: t.option(t.bool()),
});

export const Driver = t.object('Driver', {
  feature: t.string(),
  text: t.string(),
  contribution: t.f64(),
});

export const ActionInput = t.object('ActionInput', {
  eventId: t.string(),
  facilityId: t.string(),
  type: t.string(),
  trucks: t.u32(),
  tripsPerTruck: t.u32(),
  wells: t.array(t.string()),
  startAfterMin: t.u32(),
});

// ---------- datasets and clock ----------
const dataset = table(
  { name: 'dataset', public: true },
  {
    datasetId: t.string().primaryKey(),
    source: t.string(), // folder path or label
    status: t.string(), // loading | ready | error
    error: t.string(),
    tStart: t.u32(),
    tEnd: t.u32(), // "now" of the recording = last ts_unix
    stepSec: t.u32(),
    nSteps: t.u32(),
    seriesCount: t.u32(),
    rowCount: t.u32(),
    active: t.bool(),
    loadVersion: t.u32(), // bumps on every reload (cache key)
    loadedAt: t.timestamp(),
    detector: t.string(), // 'rules' | 'ml' (what produced the current events)
  },
);

/** private: raw JSON of network.json / ops.json, parsed by core/ inside reducers */
const datasetRaw = table(
  { name: 'dataset_raw' },
  {
    datasetId: t.string().primaryKey(),
    networkJson: t.string(),
    opsJson: t.string(),
  },
);

const simClock = table(
  { name: 'sim_clock', public: true },
  {
    datasetId: t.string().primaryKey(),
    nowUnix: t.u32(),
    playing: t.bool(),
    /** simulated seconds per real second while playing */
    speed: t.f64(),
    /** fractional seconds not yet applied (clock advances on the 5-min grid) */
    carrySec: t.f64(),
    /** last recompute_events run for this clock value */
    computedForUnix: t.u32(),
    computeMs: t.u32(),
  },
);

/** private: repeating timer that advances playing clocks */
const clockTimer = table(
  { name: 'clock_timer' },
  {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
  },
);

// ---------- network (from network.json) ----------
const system = table(
  { name: 'system', public: true },
  {
    key: t.string().primaryKey(), // `${datasetId}/${systemId}`
    datasetId: t.string().index('btree'),
    systemId: t.string(),
    centerLat: t.f64(),
    centerLon: t.f64(),
    yardLat: t.f64(),
    yardLon: t.f64(),
    disposalId: t.string(),
    disposalLat: t.f64(),
    disposalLon: t.f64(),
    disposalPressurePsi: t.f64(),
  },
);

const facility = table(
  { name: 'facility', public: true },
  {
    key: t.string().primaryKey(),
    datasetId: t.string().index('btree'),
    facilityId: t.string(),
    systemId: t.string(),
    lat: t.f64(),
    lon: t.f64(),
    tankId: t.string(),
    capacityBbl: t.f64(),
    pumpId: t.string(),
    maxFlowBpd: t.f64(),
    startLevelPct: t.f64(),
    stopLevelPct: t.f64(),
    pipelineId: t.string(),
    pipelineMaxBpd: t.f64(),
    pipelineMaxPressurePsi: t.f64(),
    baselineInflowBpd: t.f64(),
    revenuePerHour: t.f64(),
  },
);

const well = table(
  { name: 'well', public: true },
  {
    key: t.string().primaryKey(),
    datasetId: t.string().index('btree'),
    wellId: t.string(),
    facilityId: t.string(),
    systemId: t.string(),
    baselineWaterBpd: t.f64(),
    oilBpd: t.f64(),
    gasMcfd: t.f64(),
    revenuePerHour: t.f64(),
  },
);

// ---------- ops (from ops.json + network defaults) ----------
const opsConfig = table(
  { name: 'ops_config', public: true },
  {
    datasetId: t.string().primaryKey(),
    oilPerBbl: t.f64(),
    gasPerMcf: t.f64(),
    repairHoursPumpFailure: t.f64(),
    truckCapacityBbl: t.f64(),
    costPerTrip: t.f64(),
    warningPct: t.f64(),
    shutdownPct: t.f64(),
  },
);

const opsSystem = table(
  { name: 'ops_system', public: true },
  {
    key: t.string().primaryKey(),
    datasetId: t.string().index('btree'),
    systemId: t.string(),
    fleetSize: t.u32(),
  },
);

const opsFacility = table(
  { name: 'ops_facility', public: true },
  {
    key: t.string().primaryKey(),
    datasetId: t.string().index('btree'),
    facilityId: t.string(),
    systemId: t.string(),
    responseMin: t.f64(),
    cycleMin: t.f64(),
  },
);

// ---------- telemetry ----------
/** Chunked packed arrays: one row per (datasetId, assetId, metric, chunk of CHUNK_STEPS steps). */
const series = table(
  {
    name: 'series',
    public: true,
    indexes: [
      { accessor: 'by_dataset_asset', algorithm: 'btree', columns: ['datasetId', 'assetId'] },
    ],
  },
  {
    id: t.u64().primaryKey().autoInc(),
    datasetId: t.string().index('btree'),
    assetId: t.string(),
    metric: t.string(), // telemetry metric, or ML probability: 'ml_p_failure' | 'ml_p_degradation' | 'ml_p_leak'
    chunkIdx: t.u32(),
    t0: t.u32(), // ts of values[0]
    stepSec: t.u32(),
    values: t.array(t.f64()), // NaN = missing
  },
);

/** Latest readings per facility at the clock's nowUnix (for the map; avoids pulling series). */
const facilityState = table(
  { name: 'facility_state', public: true },
  {
    key: t.string().primaryKey(),
    datasetId: t.string().index('btree'),
    facilityId: t.string(),
    systemId: t.string(),
    asOfUnix: t.u32(),
    levelPct: t.f64(),
    inflowBpd: t.f64(),
    pumpStatus: t.f64(), // 0 stopped, 1 running, 2 fault
    pumpFlowBpd: t.f64(),
    dischargePsi: t.f64(),
    receiveFlowBpd: t.f64(),
    pipelinePressurePsi: t.f64(),
    wellsProducing: t.u32(),
    wellsTotal: t.u32(),
    /** 'ok' | 'warning' (level >= warning) | 'alert' (has an ongoing event) */
    health: t.string(),
  },
);

// ---------- events ----------
const event = table(
  { name: 'event', public: true },
  {
    eventId: t.string().primaryKey(), // `${datasetId}:${category}:${assetId}:${onsetUnix}`
    datasetId: t.string().index('btree'),
    systemId: t.string(),
    facilityId: t.string(),
    assetId: t.string(),
    category: t.string(), // pump_failure | pipeline_leak | pump_degradation
    status: t.string(), // ongoing | resolved
    onsetUnix: t.u32(),
    endUnix: t.option(t.u32()),
    confidence: t.f64(),
    source: t.string(), // ml | rules | injected
    hoursToLimitP50: t.option(t.f64()),
    hoursToLimitP10: t.option(t.f64()),
    hoursToLimitP90: t.option(t.f64()),
    levelPct: t.option(t.f64()),
    tripsAtUnix: t.option(t.u32()),
    repairEndUnix: t.option(t.u32()),
    lostRevenuePerHour: t.f64(),
    /** position in the alerts view (1 = top). 0 = not in the view (resolved). */
    alertRank: t.u32(),
    /** 'plan' for pump failures, 'field_inspection' for leaks / worn pumps */
    action: t.string(),
    /** current plan covering this event (planner proposal or approved plan) */
    planId: t.option(t.u64()),
    asOfUnix: t.u32(),
  },
);

const eventEvidence = table(
  { name: 'event_evidence', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    eventId: t.string().index('btree'),
    datasetId: t.string().index('btree'),
    rank: t.u32(),
    text: t.string(),
    source: t.string(), // rules | ml
    feature: t.string(),
    contribution: t.f64(),
  },
);

/** private: synthetic failures added for live demos (overlay on top of the recording) */
const injectedFailure = table(
  { name: 'injected_failure', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    datasetId: t.string().index('btree'),
    facilityId: t.string(),
    onsetUnix: t.u32(),
    levelPct: t.f64(), // tank level at onset
    createdBy: t.identity(),
    createdAt: t.timestamp(),
  },
);

// ---------- plans ----------
const plan = table(
  { name: 'plan', public: true },
  {
    planId: t.u64().primaryKey().autoInc(),
    datasetId: t.string().index('btree'),
    systemId: t.string(),
    eventIds: t.array(t.string()),
    origin: t.string(), // planner | agent | operator | whatif
    status: t.string(), // proposed | approved | rejected | superseded
    planStartUnix: t.u32(),
    totalCost: t.f64(),
    doNothingCost: t.f64(),
    fleetSize: t.u32(),
    trucksAvailable: t.u32(),
    valid: t.bool(),
    validationErrors: t.array(t.string()),
    summary: t.string(),
    rationale: t.string(), // agent / operator text
    overrides: t.option(PlanOverrides),
    createdBy: t.identity(),
    createdAt: t.timestamp(),
    approvedBy: t.option(t.identity()),
    approvedAt: t.option(t.timestamp()),
    agentRunId: t.option(t.string()),
    searchMs: t.u32(),
  },
);

const planAction = table(
  { name: 'plan_action', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    planId: t.u64().index('btree'),
    datasetId: t.string(),
    eventId: t.string(),
    facilityId: t.string(),
    type: t.string(), // dispatch_truck | shut_in_wells | field_inspection | none
    trucks: t.u32(),
    tripsPerTruck: t.u32(),
    wells: t.array(t.string()),
    startAfterMin: t.u32(),
    assetId: t.string(),
  },
);

/** Per-facility outcome of a plan: costs, timings and the level trace for the what-if chart. */
const planFacility = table(
  { name: 'plan_facility', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    planId: t.u64().index('btree'),
    eventId: t.string(),
    facilityId: t.string(),
    cost: t.f64(),
    truckCost: t.f64(),
    shutInCost: t.f64(),
    tripCost: t.f64(),
    doNothingCost: t.f64(),
    tripsAtUnix: t.option(t.u32()),
    tripsAtUnixIfNothing: t.option(t.u32()),
    peakLevelPct: t.f64(),
    repairEndUnix: t.u32(),
    levelAtStartPct: t.f64(),
    alreadyTripped: t.bool(),
    wellsOff: t.array(t.string()),
    truckArrivalsUnix: t.array(t.u32()),
    truckFreeAtUnix: t.array(t.u32()),
    traceT0: t.u32(),
    traceStepSec: t.u32(),
    levelTrace: t.array(t.f64()),
    summary: t.string(),
  },
);

const whatifRequest = table(
  { name: 'whatif_request', public: true },
  {
    requestId: t.u64().primaryKey().autoInc(),
    datasetId: t.string().index('btree'),
    systemId: t.string(),
    overrides: PlanOverrides,
    label: t.string(),
    requestedBy: t.identity(),
    createdAt: t.timestamp(),
  },
);

const whatifResult = table(
  { name: 'whatif_result', public: true },
  {
    requestId: t.u64().primaryKey(),
    datasetId: t.string().index('btree'),
    status: t.string(), // done | error
    error: t.string(),
    planId: t.option(t.u64()),
    baselinePlanId: t.option(t.u64()),
    totalCost: t.f64(),
    baselineCost: t.f64(),
    deltaCost: t.f64(),
  },
);

// ---------- multiplayer ----------
const operator = table(
  { name: 'operator', public: true },
  {
    identity: t.identity().primaryKey(),
    name: t.string(),
    role: t.string(), // operator | agent | worker
    online: t.bool(),
    connections: t.u32(),
    lastSeen: t.timestamp(),
  },
);

const claim = table(
  { name: 'claim', public: true },
  {
    eventId: t.string().primaryKey(),
    datasetId: t.string().index('btree'),
    claimedBy: t.identity(),
    operatorName: t.string(),
    note: t.string(),
    claimedAt: t.timestamp(),
  },
);

const handoff = table(
  { name: 'handoff', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    datasetId: t.string().index('btree'),
    author: t.identity(),
    authorName: t.string(),
    source: t.string(), // operator | agent
    text: t.string(),
    asOfUnix: t.u32(),
    agentRunId: t.option(t.string()),
    createdAt: t.timestamp(),
  },
);

// ---------- agent ----------
const agentRun = table(
  { name: 'agent_run', public: true },
  {
    runId: t.string().primaryKey(), // generated by the agent worker (reducers can't return ids)
    datasetId: t.string().index('btree'),
    eventId: t.string(), // '' if not event-triggered
    trigger: t.string(), // event_new | event_changed | question | handoff | manual
    status: t.string(), // running | done | failed
    provider: t.string(),
    model: t.string(),
    summary: t.string(),
    error: t.string(),
    planId: t.option(t.u64()),
    questionId: t.option(t.u64()),
    startedAt: t.timestamp(),
    finishedAt: t.option(t.timestamp()),
    latencyMs: t.u32(),
  },
);

const agentStep = table(
  { name: 'agent_step', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    runId: t.string().index('btree'),
    seq: t.u32(),
    kind: t.string(), // tool | llm | critic | verifier | fallback
    toolName: t.string(),
    argsJson: t.string(), // trace display only
    resultSummary: t.string(),
    ok: t.bool(),
    latencyMs: t.u32(),
    createdAt: t.timestamp(),
  },
);

const agentQuestion = table(
  { name: 'agent_question', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    datasetId: t.string().index('btree'),
    askedBy: t.identity(),
    askerName: t.string(),
    text: t.string(),
    status: t.string(), // pending | answered | failed
    answer: t.string(),
    runId: t.option(t.string()),
    createdAt: t.timestamp(),
    answeredAt: t.option(t.timestamp()),
  },
);

/** Dispatch messages drafted by the agent (or operators) for truck crews / inspectors. */
const dispatchMessage = table(
  { name: 'dispatch_message', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    datasetId: t.string().index('btree'),
    planId: t.option(t.u64()),
    eventId: t.string(),
    recipient: t.string(), // e.g. 'truck crew S2', 'field inspector'
    text: t.string(),
    agentRunId: t.option(t.string()),
    createdAt: t.timestamp(),
  },
);

/** ML sidecar status per dataset (written by the worker). */
const mlStatus = table(
  { name: 'ml_status', public: true },
  {
    datasetId: t.string().primaryKey(),
    ok: t.bool(),
    modelVersion: t.string(),
    asOfUnix: t.u32(),
    error: t.string(),
    computeMs: t.u32(),
    updatedAt: t.timestamp(),
  },
);

// ---------- private auth ----------
const admin = table(
  { name: 'admin' },
  {
    identity: t.identity().primaryKey(),
    role: t.string(), // owner | worker
  },
);

const workerKey = table(
  { name: 'worker_key' },
  {
    id: t.u32().primaryKey(),
    key: t.string(),
  },
);

const spacetimedb = schema({
  dataset,
  datasetRaw,
  simClock,
  clockTimer,
  system,
  facility,
  well,
  opsConfig,
  opsSystem,
  opsFacility,
  series,
  facilityState,
  event,
  eventEvidence,
  injectedFailure,
  plan,
  planAction,
  planFacility,
  whatifRequest,
  whatifResult,
  operator,
  claim,
  handoff,
  agentRun,
  agentStep,
  agentQuestion,
  dispatchMessage,
  mlStatus,
  admin,
  workerKey,
});
export default spacetimedb;
export { clockTimer };
