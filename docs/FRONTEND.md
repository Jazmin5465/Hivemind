# What the frontend should show

This file covers what data the backend produces, which screen it belongs on, and which reducer each button calls. It leaves out layout and styling.

- **`docs/API.md`** has every column, the connection code and the subscription queries.
- **Bindings** are generated in `frontend/src/module_bindings`.
- **Naming:** TypeScript uses camelCase (`row.hoursToLimitP50`). SQL subscription strings use snake_case (`hours_to_limit_p_50`).

## Rules for every screen

- **"Now" is `sim_clock.nowUnix`, never the browser clock.** The data is a recording from Oct 5–11, 2026. Show times in UTC.
- **Only show the active dataset**: the `dataset` row with `active = true`. Filter every subscription by its `datasetId`. When `active` moves to another dataset (the judging flip to `test`), re-subscribe.
- **Everything updates live.** Don't poll; render from the subscribed tables.
- **The backend has already done all the calculations.** Show the values as they arrive: alert order, countdowns, costs, plans. Don't recompute them in the browser.
- **Buttons call reducers, and reducers return nothing.** The result shows up as rows changing. If the backend refuses, the reducer's Promise rejects with a message; show it to the operator.

---

## 1. Header (on every screen)

| Show | Source |
|---|---|
| Active dataset name | `dataset.datasetId` (e.g. `full_week`, `test`) |
| Current time ("now") | `sim_clock.nowUnix` |
| Data range | `dataset.tStart` → `dataset.tEnd` |
| Detector in use | `dataset.detector`: `ml` (Hadent's model) or `rules` (fallback) |
| ML model status | `ml_status.ok`, `ml_status.modelVersion` |
| Who's online | `operator` rows with `online = true` (`name`) |

**Dataset switcher:** list the `dataset` rows with `status = 'ready'`. Choosing one calls `setActiveDataset({ datasetId })`. This is how we show the judges the `test` data.

**Time travel:**
- **Slider:** spans `tStart` to `tEnd`. Moving it calls `setClock({ datasetId, nowUnix })`.
- **Play / pause:** `play({ datasetId, speed })` and `pause({ datasetId })`. A speed of 300 advances one 5-minute step per second.
- **Back to now:** `resetClock({ datasetId })` jumps to the end of the recording.

All alerts, countdowns and plans recompute automatically whenever the clock moves.

## 2. Alerts view (main screen)

Show every `event` with `status = 'ongoing'`, sorted by **`alertRank`** (1 is the top). The backend already orders them the way EOG's SPEC requires: pump failures first, soonest shutdown first, then leaks and worn pumps.

**Each alert row:**

| Show | Source |
|---|---|
| Problem type | `category`: `pump_failure`, `pipeline_leak`, `pump_degradation` (show as "worn pump") |
| Where | `facilityId`, `systemId`, `assetId` |
| Started | `onsetUnix` |
| Confidence | `confidence` (0–1, show as a %). This matters most for leaks and worn pumps that are just starting. |
| Detected by | `source`: `ml`, `rules`, or `injected` (demo) |
| Who owns it | the `claim` row with the same `eventId` (`operatorName`) |

**Extra fields for pump failures:**

| Show | Source |
|---|---|
| **Countdown to shutdown** | `hoursToLimitP50`, with the range `hoursToLimitP10`–`hoursToLimitP90` |
| Shutdown time if nothing is done | `tripsAtUnix` |
| Tank level now | `levelPct` |
| Repair finishes | `repairEndUnix` |
| Revenue lost per hour if it shuts in | `lostRevenuePerHour` |
| Recommended plan and cost | `planId` → the `plan` row: `summary`, `totalCost`, `doNothingCost` |

**Leaks and worn pumps:** show the action **"Send field inspector"** (`action = 'field_inspection'`). No trucks or countdown.

**Row actions:**
- **Claim / release:** `claimEvent({ eventId, note })` and `releaseEvent({ eventId })`. A claim fails with a message if someone else already holds it.
- **Open:** goes to the alert detail screen.

## 3. Alert detail screen

### Why the app thinks this is happening
Show the `event_evidence` rows for this `eventId`, sorted by `rank`, as plain-English bullets.
- `source = 'shap'`: from Hadent's model ("why the model thinks so").
- `rules` / `ml`: from the detector.

### The plan (pump failures only)
The plan is **per system**, because tanks in a system share trucks. One plan can cover several failures. Look it up through `event.planId`.

| Show | Source |
|---|---|
| Plan status | `plan.status`: `proposed`, `approved`, `rejected`, `superseded` |
| Where it came from | `plan.origin`: `planner`, `agent`, `operator`, `whatif` |
| Total cost vs doing nothing | `plan.totalCost`, `plan.doNothingCost`; savings = the difference (agent plans have no do-nothing cost) |
| Trucks | `plan.trucksAvailable` of `plan.fleetSize` free |
| Is the plan valid? | `plan.valid`, `plan.validationErrors` (show the errors when invalid) |
| Agent's reasoning | `plan.rationale` |
| Actions | `plan_action` rows with this `planId` (below) |

**Each action** (`plan_action`) should be readable on its own:
- `dispatch_truck`: "Send **{trucks}** truck(s) to **{facilityId}**, **{tripsPerTruck}** trip(s) each."
- `shut_in_wells`: "Shut in **{wells}** **{startAfterMin}** min after the plan starts." The plan starts at `plan.planStartUnix`.
- `none`: "No action needed: the tank stays below shutdown until the repair ends."

**Per facility** (`plan_facility`, one row per failure in the plan):

| Show | Source |
|---|---|
| Cost for this facility | `cost` (split into `truckCost`, `shutInCost`, `tripCost`) |
| Shuts down? | `tripsAtUnix` is empty if the plan prevents it; otherwise it's the shutdown time |
| Shutdown time if nothing is done | `tripsAtUnixIfNothing` |
| Peak tank level under the plan | `peakLevelPct` |
| Truck arrival times | `truckArrivalsUnix` |
| Trucks free again at | `truckFreeAtUnix` |

**Approve / reject:** `approvePlan({ planId })` and `rejectPlan({ planId, reason })`. The backend re-checks the plan before approving it. If approval fails, show the error message. After an approval, the plans for the system's other failures update on their own, because those trucks are now busy.

### What-if chart
Plot `plan_facility.levelTrace` as the projected tank level, one point every `traceStepSec` seconds starting at `traceT0`. Add:
- the shutdown line from `ops_config.shutdownPct` (and the warning line from `warningPct`);
- markers at `truckArrivalsUnix` (truck arrivals) and `repairEndUnix` (repair done).

### Ask "what if?"
Shortcuts that call `requestWhatif({ datasetId, systemId, overrides, label })`:
- "Lose a truck": `{ fleetSize: <current − 1> }`. The current fleet size is `ops_system.fleetSize`.
- "Repair takes 2 h longer": `{ extraRepairHours: 2 }`
- "No trucks available": `{ noTrucks: true }`
- "Keep this well running": `{ lockedWells: ['<wellId>'] }`

The result lands in `whatif_result`: `totalCost`, `baselineCost`, `deltaCost`, and the what-if plan (`planId`) next to the baseline (`baselinePlanId`). Show both plans and their charts side by side. To recalculate the plan with overrides, call `computePlan({ datasetId, systemId, overrides })`.

## 4. Network map

- **Systems:** `system` rows. Each has `centerLat/Lon`, the truck yard (`yardLat/Lon`) and the disposal site (`disposalLat/Lon`).
- **Facilities:** `facility` rows at `lat`/`lon`. Each has one tank, pump and pipeline (`tankId`, `pumpId`, `pipelineId`). Its wells are the `well` rows with the same `facilityId`.
- **Links:** facility → its system's disposal site (pipeline); facility → its system's truck yard (truck route).

**Live readings per facility** come from `facility_state`, not from `series`:

| Show | Source |
|---|---|
| Status | `health`: `ok`, `warning` (tank at or above the warning level), `alert` (has an ongoing problem) |
| Tank level | `levelPct` (tank size: `facility.capacityBbl`) |
| Pump | `pumpStatus`: 0 stopped, 1 running, 2 fault; `pumpFlowBpd` |
| Water in / out | `inflowBpd`, `receiveFlowBpd` (at the disposal site) |
| Pressures | `dischargePsi`, `pipelinePressurePsi` |
| Wells producing | `wellsProducing` of `wellsTotal` |

Clicking a facility should open its trends and any alerts for it.

## 5. Trends (sensor charts)

Subscribe to `series` for **one asset at a time**, when its chart opens. The whole table is a full week of data, so never subscribe to all of it.

```
SELECT * FROM series WHERE dataset_id = '<ds>' AND asset_id = '<assetId>'
```

- Rows are one day each. Join them in `chunkIdx` order. `values[i]` is at time `t0 + i * stepSec`, and `NaN` means missing.
- **Only plot points at or before `sim_clock.nowUnix`.** The rows hold the whole recording, and the clock decides what counts as "now".
- Metrics:
  - **tank:** `level_pct`
  - **pump:** `status`, `flow_bpd`, `discharge_psi`
  - **pipeline:** `receive_flow_bpd`, `pressure_psi`
  - **well:** `water_bpd`, `status`
  - **facility:** `inflow_bpd`
- When ML is on, there are also probability series to show the model's confidence over time: `ml_p_failure` and `ml_p_degradation` (pumps), and `ml_p_leak` (pipelines).
- Useful reference lines: tank `ops_config.warningPct` / `shutdownPct`; the pump's `facility.maxFlowBpd`.

## 6. Agent panel (Nemotron)

This is how we show the NVIDIA track that the app is "beyond a chatbot", so make the agent's work visible.

**Agent activity:** `agent_run` rows, newest first.
- What started it: `trigger` (`event_new`, `question`, …), and `eventId`.
- Run state: `status` (`running`, `done`, `failed`), `latencyMs`, `provider` / `model`.
- **Summary:** `summary`, the agent's plain-English briefing for the operator.
- Plan link: `planId` → the plan it endorsed or proposed.

**Trace (the steps the agent took):** `agent_step` rows for the run, sorted by `seq`. Show each step's `kind`, `toolName`, `ok`, `latencyMs` and `resultSummary`.

| `kind` | Meaning to show |
|---|---|
| `tool` | it called a tool (`get_event_context`, `get_system_state`, `plan_system`, `compare_plans`, `simulate_tank`, `propose_plan`, …) |
| `llm` | a Nemotron call (tool calls it asked for, or its text) |
| `critic` | it re-checked the plan (fleet, trip timing, tank limits) |
| `verifier` | text checks: `number_check`, `fact_check`, `format_check`, `dispatch_from_plan` |
| `fallback` | it used a template instead of model text |

**Ask the agent:** a text box that calls `askAgent({ datasetId, text })`. Show the question and its answer from `agent_question` (`text`, `status` `pending`/`answered`/`failed`, `answer`). Examples:
- "What if we lose a truck?"
- "What if the repair takes 8 hours?"
- "Write the shift handoff."

**Dispatch messages:** `dispatch_message` rows, ready-to-send messages for truck crews and inspectors (`recipient`, `text`, linked to `planId` / `eventId`). They always match the endorsed plan.

## 7. Shift handoff

Show `handoff` rows, newest first: `authorName`, `source` (`operator` or `agent`), `text`, and the clock time `asOfUnix`. The agent writes a 30-second plain-English handoff when asked. Operators can write their own with `postHandoff({ datasetId, text })`.

## 8. Fleet sizing ("how big should the fleet be?")

A button calls `runFleetSweep({ datasetId })`, which fills `fleet_sweep`. For each system, show one row per fleet size:
- `fleetSize` (mark the current size, `isCurrent`);
- `totalCost` for the week's failures with that fleet;
- `trips` (failures that still shut down), `truckTrips`, `wellsShutIn`.

On the full week, one more truck saves about $2,460 in S2 and about $1,438 in S4.

## 9. Demo controls (keep off the main screen)

- **Inject a pump failure:** `injectFailure({ datasetId, facilityId, levelPct?, onsetUnix? })`. It defaults to now, at the tank's current level. Within a second it shows up as a new alert with a countdown and a plan, and the agent reacts.
- **Whole-system outage:** `injectSystemOutage({ datasetId, systemId })` fails every pump in the system at once, so you can show joint planning with shared trucks.
- **Clear demo failures:** `clearInjected({ datasetId })`.
- Show the active demo failures from `injected_failure`, and label them in the UI (their alerts have `source = 'injected'`).

## 10. Your name

`setName({ name })` sets the operator's display name, which appears on claims, handoffs and presence.
