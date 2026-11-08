# Hivemind backend API (SpacetimeDB) — for the frontend

Status: **v1, 2026-11-07 23:00 CT.** Table and reducer names are stable. New columns may be appended; nothing will be renamed without a note in this file's changelog.

Everything lives in one SpacetimeDB module, `hivemind`, on the local server. The frontend reads **tables** through subscriptions and changes things through **reducers**. Reducers return nothing, so results show up as new or updated rows.

## Connect

```ts
import { DbConnection } from './module_bindings'; // generated: client/src/module_bindings

const conn = DbConnection.builder()
  .withUri('ws://127.0.0.1:3000')      // the backend laptop's IP for other devices on the LAN
  .withDatabaseName('hivemind')
  .withToken(localStorage.getItem('stdb_token') ?? undefined)
  .onConnect((c, identity, token) => { localStorage.setItem('stdb_token', token); /* subscribe here */ })
  .build();
```

Regenerate the bindings after any backend change with `npm run server:generate` from the repo root. The bindings are committed in `client/src/module_bindings`.

## Naming conventions (read this first)

- **TypeScript bindings use camelCase.** For example `conn.db.facilityState`, `row.hoursToLimitP50`, `conn.reducers.setActiveDataset({ datasetId })`.
- **SQL subscription strings use snake_case.** Every camelCase name becomes snake_case, and digits get their own underscore: `hoursToLimitP50` becomes `hours_to_limit_p_50`, `datasetId` becomes `dataset_id`, `t0` becomes `t_0`, `traceT0` becomes `trace_t_0`, and the table `facilityState` becomes `facility_state`.
- **Times** are unix seconds (`u32` → `number`). "Now" is `sim_clock.nowUnix`, never the browser clock. The data is a recording from Oct 5–11, 2026.
- **Optional columns** are `T | undefined` in TS (shown as `?` below).
- **Money** is in USD (f64). Levels are percent full. Flows are bbl/day (bpd).
- Most tables carry a `datasetId`. Filter every subscription by the active dataset.

## Recommended subscriptions

```ts
const ds = 'full_week'; // or read the dataset row where active = true
conn.subscriptionBuilder().subscribe([
  `SELECT * FROM dataset`,
  `SELECT * FROM sim_clock`,
  `SELECT * FROM operator`,
  `SELECT * FROM system WHERE dataset_id = '${ds}'`,
  `SELECT * FROM facility WHERE dataset_id = '${ds}'`,
  `SELECT * FROM well WHERE dataset_id = '${ds}'`,
  `SELECT * FROM ops_config WHERE dataset_id = '${ds}'`,
  `SELECT * FROM ops_system WHERE dataset_id = '${ds}'`,
  `SELECT * FROM ops_facility WHERE dataset_id = '${ds}'`,
  `SELECT * FROM facility_state WHERE dataset_id = '${ds}'`,
  `SELECT * FROM event WHERE dataset_id = '${ds}'`,
  `SELECT * FROM event_evidence WHERE dataset_id = '${ds}'`,
  `SELECT * FROM plan WHERE dataset_id = '${ds}'`,
  `SELECT * FROM plan_action WHERE dataset_id = '${ds}'`,
  `SELECT * FROM plan_facility`,          // small; filter client-side by planId
  `SELECT * FROM claim WHERE dataset_id = '${ds}'`,
  `SELECT * FROM handoff WHERE dataset_id = '${ds}'`,
  `SELECT * FROM agent_run WHERE dataset_id = '${ds}'`,
  `SELECT * FROM agent_step`,              // or per run: WHERE run_id = '<runId>'
  `SELECT * FROM agent_question WHERE dataset_id = '${ds}'`,
  `SELECT * FROM dispatch_message WHERE dataset_id = '${ds}'`,
  `SELECT * FROM whatif_result WHERE dataset_id = '${ds}'`,
  `SELECT * FROM ml_status`,
  `SELECT * FROM injected_failure WHERE dataset_id = '${ds}'`,
  `SELECT * FROM fleet_sweep WHERE dataset_id = '${ds}'`,
]);
```

**Do not subscribe to all of `series`.** It holds the whole week of telemetry. Subscribe per asset when a chart opens:

```ts
`SELECT * FROM series WHERE dataset_id = '${ds}' AND asset_id = 'S1_TANK_A'`
```

For the map and the live readings, use `facility_state` instead. It holds the latest values at the clock.

## Tables

### Datasets and clock

**`dataset`** (PK `datasetId`): one row per loaded folder.
`datasetId` (the folder name: `full_week`, `snapshot_…`, `mock_test_…`, `test`), `source`, `status` (`loading` | `ready` | `error`), `error`, `tStart`, `tEnd` (the recording's "now", the last ts in the telemetry), `stepSec` (300), `nSteps`, `seriesCount`, `rowCount`, **`active`** (exactly one dataset is active; the console should show that one), `loadVersion`, `loadedAt`, `detector` (`rules` | `ml`: what produced the current events).

**`sim_clock`** (PK `datasetId`): the time-travel clock.
`nowUnix` (everything else is computed as of this time), `playing`, `speed` (simulated seconds per real second), `carrySec`, `computedForUnix`, `computeMs`.
After a load, `nowUnix = tEnd`. Events, countdowns and plans are recomputed causally, using only data at or before `nowUnix`, whenever the clock moves.

### Network (from network.json)

**`system`** (PK `key` = `${datasetId}/${systemId}`): `systemId`, `centerLat`, `centerLon`, `yardLat`, `yardLon` (truck yard), `disposalId`, `disposalLat`, `disposalLon`, `disposalPressurePsi`.

**`facility`** (PK `key`): `facilityId`, `systemId`, `lat`, `lon`, `tankId`, `capacityBbl`, `pumpId`, `maxFlowBpd`, `startLevelPct`, `stopLevelPct`, `pipelineId`, `pipelineMaxBpd`, `pipelineMaxPressurePsi`, `baselineInflowBpd` (sum of the wells' baseline water), `revenuePerHour` (oil and gas revenue of all its wells).
Each facility has one tank, one pump and one pipeline. Their IDs are the columns above.

**`well`** (PK `key`): `wellId`, `facilityId`, `systemId`, `baselineWaterBpd`, `oilBpd`, `gasMcfd`, `revenuePerHour`.

### Ops (from ops.json plus the network defaults)

**`ops_config`** (PK `datasetId`): `oilPerBbl`, `gasPerMcf`, `repairHoursPumpFailure`, `truckCapacityBbl`, `costPerTrip`, `warningPct`, `shutdownPct` (tank limits).
**`ops_system`** (PK `key`): `systemId`, `fleetSize` (the emergency trucks shared by the whole system).
**`ops_facility`** (PK `key`): `facilityId`, `systemId`, `responseMin` (call to first arrival), `cycleMin` (one round trip).

### Live state and telemetry

**`facility_state`** (PK `key`): the latest readings at `sim_clock.nowUnix`, for the map.
`facilityId`, `systemId`, `asOfUnix`, `levelPct`, `inflowBpd`, `pumpStatus` (0 stopped, 1 running, 2 fault), `pumpFlowBpd`, `dischargePsi`, `receiveFlowBpd`, `pipelinePressurePsi`, `wellsProducing`, `wellsTotal`, **`health`** (`ok` | `warning` (level ≥ warning) | `alert` (has an ongoing event)).

**`series`** (PK `id`): telemetry as chunked arrays. One row per (asset, metric, day).
`datasetId`, `assetId`, `metric`, `chunkIdx`, `t0` (ts of `values[0]`), `stepSec`, `values: number[]` (`NaN` = missing). The timestamp of `values[i]` is `t0 + i * stepSec`. Concatenate rows by `chunkIdx` to get a full series. **Only plot points with ts ≤ `sim_clock.nowUnix`**: the rows hold the whole recording, and the clock decides what counts as "now".

Metrics by asset:

| Asset | Metrics |
|---|---|
| facility | `inflow_bpd` |
| well | `water_bpd`, `status` |
| tank | `level_pct` |
| pump | `status`, `flow_bpd`, `discharge_psi` |
| pipeline | `receive_flow_bpd`, `pressure_psi` |

When the ML sidecar has run, there are also per-step probabilities: `ml_p_failure` and `ml_p_degradation` on pumps, and `ml_p_leak` on pipelines.

### Alerts

**`event`** (PK `eventId` = `${datasetId}:${category}:${assetId}:${onsetUnix}`, stable across recomputes):

| Column | Meaning |
|---|---|
| `systemId`, `facilityId`, `assetId` | the pump for pump problems, the pipeline for leaks |
| `category` | `pump_failure` \| `pipeline_leak` \| `pump_degradation` |
| `status` | `ongoing` \| `resolved` |
| `onsetUnix`, `endUnix?` | `endUnix` stays empty while ongoing |
| `confidence` | 0..1; grows as a slow problem develops |
| `source` | `rules` \| `ml` \| `injected` (demo overlay) |
| `hoursToLimitP50?`, `hoursToLimitP10?`, `hoursToLimitP90?` | the countdown to shutdown; ongoing pump failures only |
| `levelPct?`, `tripsAtUnix?`, `repairEndUnix?` | tank level now, when it trips if nothing is done, when the repair ends |
| `lostRevenuePerHour` | revenue lost per hour if the facility shuts in |
| **`alertRank`** | the position in the alerts view (1 = top), **already ordered per SPEC**: pump failures by smallest `hoursToLimitP50` (ties go to higher `lostRevenuePerHour`), then leaks, then worn pumps. **0 = resolved, not in the view.** |
| `action` | `plan` (pump failure) \| `field_inspection` (leak or worn pump) |
| `planId?` | the plan covering this event: the approved plan if there is one, else the planner's proposal |
| `asOfUnix` | the clock time this row was computed for |

**`event_evidence`** (PK `id`): plain-English reasons, ordered by `rank` (ascending).
`eventId`, `rank`, `text`, `source` (`rules` | `ml` | `injected` | `shap`), `feature`, `contribution` (SHAP log-odds; `shap` rows only, ranks 101–103).

**`injected_failure`**: active demo overlays (see `inject_failure`).

### Plans

**`plan`** (PK `planId`):

| Column | Meaning |
|---|---|
| `systemId`, `eventIds: string[]` | one plan covers **all** of a system's ongoing pump failures jointly, because they share trucks |
| `origin` | `planner` (auto, re-optimized at every clock change) \| `agent` \| `operator` \| `whatif` |
| `status` | `proposed` \| `approved` \| `rejected` \| `superseded` |
| `planStartUnix`, `totalCost`, `doNothingCost` | savings = `doNothingCost − totalCost`; `doNothingCost` is NaN for agent plans |
| `fleetSize`, `trucksAvailable` | trucks busy on earlier approved plans are not available |
| `valid`, `validationErrors: string[]` | the module re-validates every plan: fleet limit, trips arriving before the repair ends, tank volume |
| `summary`, `rationale` | `rationale` holds the agent or operator text |
| `overrides?`, `createdBy`, `createdAt`, `approvedBy?`, `approvedAt?`, `agentRunId?`, `searchMs` | |

**`plan_action`** (PK `id`): matches the `events.json` action shape in SPEC.md.
`planId`, `eventId`, `facilityId`, `type` (`dispatch_truck` | `shut_in_wells` | `none` | `field_inspection`), `trucks`, `tripsPerTruck`, `wells: string[]`, `startAfterMin` (minutes after `planStartUnix`), `assetId`.

**`plan_facility`** (PK `id`): the per-facility outcome, used for the what-if chart.
`planId`, `eventId`, `facilityId`, `cost`, `truckCost`, `shutInCost`, `tripCost` (lost revenue if it still trips), `doNothingCost`, `tripsAtUnix?` (empty = trip prevented), `tripsAtUnixIfNothing?`, `peakLevelPct`, `repairEndUnix`, `levelAtStartPct`, `truckArrivalsUnix: number[]`, `truckFreeAtUnix: number[]`, **`levelTrace: number[]`** (the projected tank level every `traceStepSec` seconds from `traceT0` until the repair ends), `summary`.

**`whatif_request`** and **`whatif_result`** (PK `requestId`): `whatif_result` has `status` (`done` | `error`), `error`, `planId?` (the what-if plan), `baselinePlanId?`, `totalCost`, `baselineCost`, `deltaCost`. Match a result to your request through `whatif_request.requestedBy` = your identity (the newest row).

**`fleet_sweep`** (PK `key`): the "how big should the fleet be?" analysis, filled by `runFleetSweep`.
`systemId`, `fleetSize`, `isCurrent` (the fleet size from ops.json), `failures`, `totalCost` (the week's response cost with that fleet), `trips` (failures that still trip), `truckTrips`, `wellsShutIn`, `asOfUnix`.

### Multiplayer

**`operator`** (PK `identity`): `name`, `role` (`operator` | `agent`), `online`, `connections`, `lastSeen`. Use it for presence.
**`claim`** (PK `eventId`): `claimedBy` (identity), `operatorName`, `note`, `claimedAt`. Shows who owns which alert.
**`handoff`** (PK `id`): `authorName`, `source` (`operator` | `agent`), `text`, `asOfUnix`, `agentRunId?`, `createdAt`. The shift handoff notes.

### Agent (Nemotron, running in the worker)

**`agent_run`** (PK `runId: string`): `eventId`, `trigger` (`event_new` | `event_changed` | `question` | `handoff` | `manual`), `status` (`running` | `done` | `failed`), `provider`, `model`, `summary`, `error`, `planId?`, `questionId?`, `startedAt`, `finishedAt?`, `latencyMs`.
**`agent_step`** (PK `id`): `runId`, `seq`, `kind` (`tool` | `llm` | `critic` | `verifier` | `fallback`), `toolName`, `argsJson`, `resultSummary`, `ok`, `latencyMs`. This is the trace view.
**`agent_question`** (PK `id`): `askerName`, `text`, `status` (`pending` | `answered` | `failed`), `answer`, `runId?`.
**`dispatch_message`** (PK `id`): drafted messages for truck crews and inspectors. `planId?`, `eventId`, `recipient`, `text`.
**`ml_status`** (PK `datasetId`): `ok`, `modelVersion`, `asOfUnix`, `error`, `computeMs`. Use it for an "ML online" badge.

## Reducers the frontend calls

Use the camelCase TS name, for example `conn.reducers.approvePlan({ planId })`. Each call returns a Promise that rejects with the error message if the module refuses.

| Reducer | Args | What it does |
|---|---|---|
| `setActiveDataset` | `datasetId` | flips the live app to another loaded dataset (the `test/` flip) |
| `setClock` | `datasetId, nowUnix` | time travel; snaps to the 5-min grid and recomputes |
| `play` | `datasetId, speed` | auto-advance. `speed` = simulated seconds per real second (300 = one 5-min step per second). Restarts from `tStart` if the clock is at the end. |
| `pause` | `datasetId` | |
| `resetClock` | `datasetId` | jumps back to the recording's "now" (`tEnd`) |
| `recomputeEvents` | `datasetId` | forces a recompute (normally automatic) |
| `computePlan` | `datasetId, systemId, overrides?` | inserts a fresh optimal plan with `origin: 'operator'` |
| `requestWhatif` | `datasetId, systemId, overrides, label` | baseline plan vs plan with overrides → a `whatif_result` row |
| `approvePlan` | `planId` | re-validates, then approves. Its trucks become busy and its events are marked handled. Rejects with the errors if the plan is invalid. |
| `rejectPlan` | `planId, reason` | also un-approves an approved plan, which releases its trucks |
| `prunePlans` | `datasetId` | deletes what-if, rejected and superseded plans |
| `claimEvent` | `eventId, note` | fails if someone else holds the claim |
| `releaseEvent` | `eventId` | |
| `postHandoff` | `datasetId, text` | |
| `setName` | `name` | operator display name |
| `askAgent` | `datasetId, text` | natural-language question; the agent answers in `agent_question` |
| `injectFailure` | `datasetId, facilityId, levelPct?, onsetUnix?` | live-demo pump failure. Defaults: now, at the tank's current level. |
| `injectSystemOutage` | `datasetId, systemId` | demo: every pump in the system fails now (e.g. "the disposal site shuts down"); planned jointly |
| `clearInjected` | `datasetId` | removes all overlays |
| `runFleetSweep` | `datasetId` | fills `fleet_sweep`: the week's pump failures replayed for fleet sizes 0..current+2 |

`overrides` (`PlanOverrides`), with every field optional: `{ fleetSize?, repairHours?, extraRepairHours?, truckCapacityBbl?, costPerTrip?, lockedWells?: string[], noTrucks?: boolean }`.
Examples:
- "What if we lose a truck?" → `{ fleetSize: n − 1 }`
- "The repair takes 2 h longer" → `{ extraRepairHours: 2 }`

Worker-only reducers (`loadDataset*`, `ml*`, `agent*`, `registerWorker`, `setWorkerKey`, `deleteDataset`) reject calls from browser identities.

## Typical UI flows

- **Alerts view:** events with `status == 'ongoing'`, sorted by `alertRank`. For a pump failure, show the countdown (`hoursToLimitP50`, with the p10–p90 band) and `planId` → `plan_action` + `plan_facility`. For a leak or worn pump, show "send inspector" plus `event_evidence`.
- **What-if chart:** `plan_facility.levelTrace` against the shutdown line (`ops_config.shutdownPct`), with truck arrivals from `truckArrivalsUnix`.
- **Approve:** `approvePlan(planId)`. The planner then re-plans the remaining events with fewer free trucks.
- **Time travel:** a slider over `[dataset.tStart, dataset.tEnd]` calls `setClock`. Every alert, countdown and plan updates through the subscriptions.
- **Demo:** `injectFailure(ds, 'S1_FACILITY_A')` creates a new ongoing failure with a countdown and a plan within one transaction.

## Changelog
- v1.1 (2026-11-07 23:30): + `fleet_sweep` table, `runFleetSweep`, `injectSystemOutage`.
- v1 (2026-11-07 23:00): first version.
