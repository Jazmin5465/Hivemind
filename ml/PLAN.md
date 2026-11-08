# Approach: Beat the Shutdown

How we plan to detect problems, explain them, and recommend the cheapest fix.
This is the current plan, not final. Decisions are marked with why we made them.

## The goal in one paragraph

Load any dataset folder (`network.json`, `ops.json`, `telemetry.csv`), find the
leaks, worn pumps and pump failures from the sensor readings alone, show a
countdown to shutdown for pump failures, and recommend the cheapest plan.
"Now" is the last timestamp in the telemetry, never the system clock.
`answer_key.json` is only for checking our work. The app must never load it.

## What the data gives us

- 23 labelled events in `history/full_week/` (13 pump failures, 5 leaks, 5 worn pumps), plus 3 snapshots and a mock test.
- Three worn pumps are followed by a failure at the same pump, starting at the exact minute the degradation ends (S1_FACILITY_C, S3_FACILITY_A, S4_FACILITY_C). The docs call these separate events. All other same-facility pairs are days apart and unrelated.
- The docs say "no linked events", so there is no cause-and-effect label to learn. The only other coupling is shared trucks: pump failures in one system within about an hour compete for the same fleet.
- The unseen `test/` network (S6 to S11) arrives right before judging.

## Pipeline

```
telemetry.csv + network.json + ops.json
        |
        v
 1. Features (normalized per asset, rolling windows)
        |
        v
 2. Detector (learned model)  -> events: category, onset, end, confidence
        |
        +--> 3. Explanations (SHAP) -> evidence per alert
        |
        v
 4. Countdown (physics formula) -> hours to shutdown for pump failures
        |
        v
 5. Plan search (exact search) -> cheapest trucks / shut-in plan per system
        |
        v
 6. Links -> dependency graph between events
        |
        v
 7. LLM layer -> plain-English text and shift handoff
```

### What is learned vs. what stays code

| Piece | Approach | Why |
|---|---|---|
| Detecting leaks, worn pumps, failures | **Learned** (LightGBM) | Our goal: learn the rules from data instead of hand-written thresholds |
| Time to shutdown | Formula | Level change per hour is `(inflow - pump flow) / 24 / capacity * 100`. It is exact, so learning it only adds error |
| Cheapest plan | Search | The plan rules in SPEC.md are exact and cost depends on shared trucks. Search beats a learned model |
| Writing the explanation text | LLM | Reads structured output only. It cannot create events or edges |

## Generating more data

We have too few events (23) to train on. The original generator is not available:
`CLAUDE.md` mentions `organizer/generate.py`, but `organizer/` is gitignored and
not in the public repo. So we write our own simulator from `SPEC.md`.

1. **Build the simulator** from SPEC.md: tank formula, pump setpoints (on at 70%, off at 30%), pressure rules, automatic shut-in at 92%, 6-hour repairs, 5-minute grid. It takes any `network.json` plus a list of incidents and writes the same `telemetry.csv` format plus labels.
2. **Calibrate** what SPEC does not give us (noise level, leak size, degradation rate) by measuring the 10 leak and worn-pump events in `full_week`. Check that the simulator can reproduce the real week closely.
3. **Randomize widely:** different network sizes and tank/pump numbers, incident timing and severity, overlapping failures in one system, and degradation-then-failure chains.
4. **Train on synthetic weeks only.** The real folders (`full_week`, snapshots, mock test) are held out to validate.

Risk: the model learns our simulator's assumptions. The real-week check is how we know whether it carries over.

## The detection model

**Choice: LightGBM (gradient-boosted trees) on windowed features.**

Why this and not a neural network:
- The signals are physical and tabular (flow ratios, pressure offsets, level slopes).
- Trees train well on thousands of synthetic weeks with little tuning.
- We can show why a prediction was made (below).
- Fast enough to rescore every 5 minutes.

Design points:
- One row per asset per timestamp, with features from trailing windows (30 min, 2 h, 6 h, 24 h).
- Features are **normalized** (for example pump flow as a fraction of `max_flow_bpd`) so the model works on the unseen test network.
- Target is a class: normal, leak, degradation, or pump failure.
- Onset and end come from smoothing the per-step probabilities and taking the start and end of each run above a threshold. The same probabilities give the confidence score.
- Slow problems may show up late to a window model. A change-point detector or Kalman filter on pump efficiency can add an earlier warning. Only add it if the trees miss slow events.
- **Split by simulated week, not by row.** Neighboring 5-minute rows are nearly identical, so a row split would report accuracy that does not hold on a new week.

## Explaining predictions

- **Per alert:** SHAP values (`predict(..., pred_contrib=True)`). They add up exactly to the model's output, so we can show the top three drivers as the alert's evidence. The `evidence` field in the `events.json` shape fits this directly.
- **Overall:** `feature_importance(importance_type="gain")` shows which signals matter most per class.
- **Readable rules for a demo:** train a shallow decision tree (depth 3 to 4) on the same features. It prints as plain if-then rules.
- SHAP shows what the model relied on, not the physical cause. Correlated features split credit between them, so keep features distinct.

## Event links (dependency graph)

Draw an edge only where there is evidence, never from a hardcoded ID:
- **"Progressed to failure":** a degradation that ends at the same asset and timestamp a pump failure starts. Three examples exist, so label it an observed pattern, not a prediction.
- **"Competes for trucks":** pump failures in the same system within about an hour.
- Everything else stays unconnected.
- Use the worn-pump pattern as a prior that raises the chance of a failure for a pump that keeps declining, shown as a confidence, never as a certainty.

## Plan search

- Options per pump failure: trucks (flat price per trip, first trip after `response_min`, then every `cycle_min`), shut in wells early (lost oil and gas revenue), or do nothing.
- Plan all ongoing failures in a system **together**, since they share its fleet. A one-event-at-a-time approach will not match the snapshot answers. For example, in the 10-08 12:00 snapshot the second truck goes to EVENT_13 and EVENT_12 shuts in a well instead.
- Compare our costs against the answer keys for the snapshots, which are planned from "now". `full_week` plans are made at each event's onset, so they differ.

## Fixing predicted events: the `/fixes` endpoint

How a predicted event becomes a list of ways to fix it, each with its costed consequences. Everything below comes from the ZeroDay repo's own rules (README.md "The decision", SPEC.md "Plans", and the worked EVENT_9 example). Where the repo is silent, this section says so and does not invent a number.

### Where the input comes from

1. LightGBM `/detect` returns per-step probabilities. The backend turns them into an event: category, asset, onset, confidence.
2. The fixes step takes that event and reads **only** the dataset folder up to "now" (`network.json`, `ops.json`, telemetry). It never reads `answer_key.json`.
3. From the data at "now" it takes: the tank's current level, each well's current water rate, tank capacity, the shutdown and warning limits, the repair time left, the system's fleet size and which trucks are busy.
4. Repair end = event onset + `expected_repair_hours.pump_failure`. The horizon is the time remaining to that point (SPEC.md "Horizon").

### What the repo does for each category

| Category | Repo's action | Our fixes |
|---|---|---|
| `pump_failure` | Cheapest of: send trucks, shut in some wells early, both, or do nothing | Several fixes from the exact search, below |
| `pipeline_leak` | `field_inspection`, urgent. The pump still moves water, so no alternative disposal is needed | Inspect now, and a "no action" fix showing what happens if ignored |
| `pump_degradation` | `field_inspection`. Same reasoning | Same as leak |

### Cost rules, as the repo defines them

- **Trucks:** all trucks in a plan arrive `response_min` after the call, then each truck can return every `cycle_min`. A trip removes `truck_capacity_bbl` and costs a flat `cost_per_trip`. `cost = trucks × trips × cost_per_trip`, `bbl removed = trucks × trips × truck_capacity_bbl`.
- **Truck limits:** at most `emergency_fleet_size` trucks per system, every trip must arrive before the repair ends, a trip cannot remove more water than is in the tank, and a trip arriving after the tank has tripped does not prevent it. A truck is busy until `cycle_min` after its last trip, and its next job starts from the yard, so it takes the new facility's `response_min` again.
- **Shut in wells:** instant, can start late, lasts until the repair ends. `lost revenue per day = oil_bpd × oil_per_bbl + gas_mcfd × gas_per_mcf`; `cost = lost revenue per hour × hours shut`. Cheapest wells to shut first: `cost per bbl avoided = lost revenue per day ÷ baseline_water_bpd`.
- **Do nothing:** the tank trips at the shutdown limit and all of the facility's wells shut in until the repair ends. `cost = facility lost revenue per hour × hours shut`.
- **Mixed plans** are allowed (for example one truck now plus a late shut-in of a cheap well).
- **Not in the repo:** a price for an inspection, and an inspector's travel time. So inspection fixes carry `cost: 0` with a reasoning string that says it is unpriced, not free. Never invent one.

### The search (exact, small)

For one pump failure:

1. **Countdown.** With the pump stopped, level rises by `inflow ÷ 24 ÷ capacity × 100` points per hour. If the level stays below the shutdown limit until the repair ends, the only candidate is "no action needed" at $0 (the practice week's EVENT_6 is this case).
2. **Candidates**, all simulated on the 5-minute grid with the same tank model used by `what_if`:
   - truck-only: every `(trucks, trips)` with arrivals before the repair ends, capped by trucks free;
   - shut-in-only: every subset of the facility's wells (at most 2^4) with the **latest** start time that still keeps the level under the limit (later start means less lost revenue);
   - mixed: every `(trucks, trips)` combined with the best well subset for what remains;
   - do nothing.
3. **Feasibility check** on each: fleet limit, trips arrive in time, removal not above tank volume, level under the shutdown limit (except "do nothing"). Infeasible candidates are dropped.
4. **Pick the ways to return** (default 4, `maxFixes`): the cheapest overall (recommended, listed first), cheapest truck-only, cheapest shut-in-only, do nothing. Duplicates are removed. Sorted by cost ascending.

**Several failures in one system.** They share the fleet, so the search is joint:
- Enumerate how the free trucks are split across the system's ongoing failures (fleet is 2 to 3 and events are 1 to 3, so this is tiny), plus each event's wells, and minimize the **total** cost. A truck sent to one tank stays busy until `cycle_min` after its last trip, then restarts from the yard.
- The first fix for an event is its slice of that joint optimum.
- The other fixes for the event hold the other events at their joint-optimal plans and use only the trucks left. They may cost more than the first fix, which is the trade-off being shown.
- This is what reproduces the snapshot answers: in the 10-08 12:00 snapshot the second truck goes to EVENT_13 and EVENT_12 shuts in a well instead.

**Default assumptions**, matching how the repo's reference plans are made: inflow is the current observed rate and stays flat; the repair finishes exactly at onset plus repair hours. An optional safety margin (plan against the p90 inflow) is available for what-ifs but is off by default, because it would not match the repo's reference costs.

### Leaks and worn pumps

The repo's only remedy is an inspection, so these events get two fixes:
- **Send an inspector now.** Cost 0 (unpriced). The sequence says what to expect once repaired. In the practice data a leak or worn pump ends abruptly at repair and the readings return to normal.
- **No action (monitor only).** Cost 0 (unpriced). The sequence extrapolates the trend **measured on this asset in the data** (not a stored constant): a leak's loss growing until a stated percent of pumped flow by a stated time; for a worn pump, the time at which its flow falls below the facility's inflow, after which the tank starts to fill and a shutdown becomes possible. A worn pump may also progress to failure; in the practice week three of five did, so this is listed as a risk, not a prediction.

### Endpoint

`POST /fixes`

Request:
```json
{
  "datasetDir": "/abs/path/to/folder",
  "asOfUnix": 1791418800,
  "event": {"eventId": "EVENT_9", "category": "pump_failure", "assetId": "S1_PUMP_C",
            "onsetUnix": 1791418800, "confidence": 0.99},
  "otherEvents": [ /* the other ongoing events; same shape; the service uses those in the same system */ ],
  "overrides": {"fleetSize": 1, "repairHours": 8},
  "maxFixes": 4
}
```
`overrides` is how the agent answers what-ifs ("what if we lose a truck?"). It changes inputs and never changes the recorded data.

Response: exactly this JSON Schema (strict; no extra fields allowed).

```json
{
  "type": "object",
  "properties": {
    "eventId": {"type": "string", "description": "The unique identifier or title of the event being resolved."},
    "fixes": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "fixDescription": {"type": "string", "description": "Clear explanation of the corrective action applied."},
          "predictedSequence": {"type": "array", "items": {"type": "string"},
            "description": "Chronological list of expected outcomes or events occurring after this specific fix."},
          "cost": {"type": "number", "description": "Total monetary or resource cost for this fix as a numeric value."},
          "costReasoning": {"type": "string", "description": "Detailed explanation breakdown of how this fix's cost was computed."}
        },
        "required": ["fixDescription", "predictedSequence", "cost", "costReasoning"],
        "additionalProperties": false
      },
      "description": "List of proposed fixes addressing the event."
    }
  },
  "required": ["eventId", "fixes"],
  "additionalProperties": false
}
```

How each field is filled (all by code, not by the LLM):
- `eventId`: echoed from the request.
- `fixDescription`: a sentence generated from the structured plan (trucks, trips, wells, start times).
- `predictedSequence`: one string per expected event, oldest first, each as `"<UTC time> - <what happens>"`. Taken from the simulated timeline of that fix: truck arrival and bbl removed, wells shut in or resumed, tank crossing the warning level, tank reaching or missing the shutdown limit, repair complete, truck back at the yard (fleet free again). The truck-return line matters because it tells the next failure in the system how many trucks it will find.
- `cost`: dollars, from `ops.json` prices and the formulas above.
- `costReasoning`: the formula with its inputs, generated from the same numbers as `cost`.

**Open item:** the schema has no machine-readable plan, but `approve_plan` and the module's re-validation need trucks, trips, wells and start times. Proposal: a sibling `POST /fixes/plans` with the same request, returning the same fixes in the same order as structured actions (`dispatch_truck`, `shut_in_wells`, `field_inspection`, `none`, the shape in SPEC.md's `events.json`). Needs a yes from the backend side.

**Decided:** the planner and `/fixes` are implemented once, by the backend in `core/` (TypeScript), where the backend spec already puts the countdown and planner. The Python sidecar holds only the detector (`/health`, `/detect`, `/explain`) and does not duplicate the planner. This section is the specification for that implementation; the tests below are its acceptance checks.

What the Python side hands over:
- The detector's events, through `/detect` (the backend groups them into events).
- The worked EVENT_9 example above as a first test vector.
- The reference costs in the snapshot answer keys, which are the expected values for the second test.
- A synthetic network from the generator (`ml/gen_data.py`) for the "nothing tied to one network" test.

### Worked example: EVENT_9 planned at onset

Inputs from the practice data: S1_FACILITY_C, 800 bbl tank at 50%, inflow 1,800 bpd (75 bbl/h), repair 6 h from 00:20, shutdown limit 92%, warning 85%, truck response 75 min and cycle 230 min, $905 per trip, 150 bbl per trip. Costs match the README's table; times and levels are computed from those inputs.

```json
{
  "eventId": "EVENT_9",
  "fixes": [
    {
      "fixDescription": "Send 1 truck to S1_FACILITY_C now for 1 trip (150 bbl) and keep all three wells producing.",
      "predictedSequence": [
        "2026-10-08T01:35Z - Truck arrives and removes 150 bbl; tank drops from 61.7% to 43.0%",
        "2026-10-08T05:25Z - Truck is back at the yard; S1 has both trucks free again",
        "2026-10-08T06:04Z - Tank crosses the 85% warning level",
        "2026-10-08T06:20Z - Repair completes and the pump restarts; tank peaked at 87.5%, below the 92% shutdown limit, so no wells were shut in"
      ],
      "cost": 905.00,
      "costReasoning": "1 truck x 1 trip x $905 per trip = $905. The trip arrives 75 min after the call (response_min) and removes 150 bbl (truck_capacity_bbl), which keeps the tank at or below 87.5% until the repair ends. No wells are shut in, so there is no lost revenue."
    },
    {
      "fixDescription": "Shut in S1_WELL_C2 at 02:25 and keep it off until the repair ends. No trucks.",
      "predictedSequence": [
        "2026-10-08T02:25Z - S1_WELL_C2 shut in (700 bbl/day of water stops); tank is at 69.5%",
        "2026-10-08T05:07Z - Tank crosses the 85% warning level",
        "2026-10-08T06:20Z - Repair completes; tank peaked at 91.97%, just under the 92% shutdown limit, and S1_WELL_C2 is turned back on"
      ],
      "cost": 1958.33,
      "costReasoning": "S1_WELL_C2 makes 170 bbl of oil and 600 mcf of gas a day: 170 x $60 + 600 x $3 = $12,000 a day = $500 an hour. It is off from 02:25 to 06:20 = 3.92 h, so $500 x 3.92 = $1,958. 02:25 is the latest start that still keeps the tank under the limit. No truck trips."
    },
    {
      "fixDescription": "Do nothing and let the tank trip, shutting in all three wells automatically.",
      "predictedSequence": [
        "2026-10-08T04:04Z - Tank crosses the 85% warning level",
        "2026-10-08T04:49Z - Tank reaches the 92% shutdown limit; S1_WELL_C1, S1_WELL_C2 and S1_WELL_C3 shut in automatically",
        "2026-10-08T06:20Z - Repair completes; the pump restarts and the wells resume"
      ],
      "cost": 5016.00,
      "costReasoning": "All three wells are off from 04:49 to 06:20 = 1.52 h. Lost revenue per hour: C1 (560 x $60 + 2,000 x $3) + C2 (170 x $60 + 600 x $3) + C3 (390 x $60 + 1,400 x $3) = $79,200 a day = $3,300 an hour. $3,300 x 1.52 h = $5,016."
    }
  ]
}
```

### How the agent uses it

- New tool `get_fixes(eventId, overrides?)` wraps the endpoint. The agent explains which fix is recommended (lowest `cost`) and why the others cost more, and may add qualitative notes (for example a low-margin plan that peaks at 91.97%).
- The agent never edits a cost, a time or the order. The number-check pass compares every dollar figure, time and level in its text with the response and rejects a mismatch.
- For "what if" questions the agent calls `get_fixes` again with `overrides`.
- Plans are advice only. Approval goes through `approve_plan`, which re-validates the plan.

### Tests for this endpoint

1. EVENT_9 example above: $905 / $1,958 / $5,016 and the peak levels.
2. For each snapshot, the first fix's cost for every ongoing pump failure equals the answer key's `reference_action` cost, planned from "now" with the system's trucks shared. Compare `full_week` plans separately, since those are planned at each onset.
3. A case where the tank never trips returns the single "no action needed" fix.
4. A system with 3 simultaneous failures never uses more than `emergency_fleet_size` trucks in total.
5. The response validates against the schema above with `additionalProperties: false`.
6. Run on `mock_test_*` and a synthetic network to confirm nothing is tied to the practice network.

## Validation

1. Detect every labelled event in `full_week` with category, onset and end close to the key.
2. Match the snapshot alert order (`order`) and `hours_to_limit_final`.
3. Run the mock test (no key) as a dress rehearsal for the `test/` folder.
4. Count false alarms on normal stretches.
5. Switch datasets with no code changes.

## Compute: NVIDIA Brev

What runs where:

| Job | Where | Why |
|---|---|---|
| Simulator and data generation | Brev CPU cores | Plain Python and NumPy. About 2 s per simulated week, about 70 s per 40-week feature table |
| LightGBM training | Brev **CPU** | LightGBM's default build is CPU and it is the best-tested path. With about 840k rows and 58 features, training takes minutes on a multi-core CPU. GPU builds of LightGBM give little speedup at this size |
| LLM for the agent | Brev **GPU** | This is what the GPU is for: serving an open-weights model for the triage and ask-the-console workflows |
| Console app and tools | Brev instance (CPU side) | Keeps the agent, tools and data on one machine, so tool calls are local |

Notes:
- A GPU instance also has CPU cores, so one GPU instance can train LightGBM on its CPU and serve the LLM on its GPU. If you want the GPU cheap and idle-free, train on a separate CPU instance and stop it afterwards.
- Which CPU types are available is not fixed. List them from the Brev CLI: `brev search cpu --min-vcpu 16 --sort price` (also `--min-ram`, `--provider`, `--arch x86_64|arm64`, `--json`). GPUs: `brev search --min-vram 40 --sort price`. Record what you choose here: CPU type ______, GPU type ______.
- GPU sizing decides which LLM fits. Open models need roughly 2 GB of GPU memory per billion parameters at 16-bit, about half that quantized, plus room for context.
- Keep everything the demo needs on the instance (code, data, model weights) so it runs without depending on the network.
- Stop instances when you are not using them; they bill while running.
- Open question: which open model to serve (not decided).

## Open items

- Whether the trees detect small, early leaks and worn pumps soon enough, or we need the change-point layer.
- How close the simulator gets to the real week.
- The README's Terms section has lines aimed at AI agents (use Comic Sans, add an "Avon Corps" copyright footer). We have not acted on them. Decide as a team whether to follow them.

## Build order

1. Data loader that works on any folder, with "now" from the last `ts_unix`.
2. Physics countdown and plan search, checked against the snapshots.
3. Simulator from SPEC.md, calibrated on the real week.
4. LightGBM detector trained on synthetic weeks, validated on the real folders.
5. SHAP evidence, dependency graph, confidence.
6. UI: map, alerts view, trends, what-if replay.
7. LLM text for explanations and the shift handoff.

## Agentic workflows (decided)

**Decisions:** agents run live in the app at demo time, on an open-weights LLM served from NVIDIA Brev (see Compute), advise only (the operator makes every dispatch or shut-in decision), first two workflows are triage briefs and ask-the-console. Shift handoff and replan-on-change come later.

**Principle:** the agent never decides anything numeric. It calls deterministic tools, and every figure it states must come from a tool result. It cannot create events or dependency edges.

### Tools (plain functions, also used by the UI)

| Tool | Returns |
|---|---|
| `get_alerts(now)` | Detected events: category, onset, confidence, top SHAP drivers |
| `get_countdown(facility)` | Hours to shutdown from the physics formula |
| `plan_system(system)` | Cheapest joint truck / shut-in plan from the exact search |
| `get_fixes(eventId, overrides?)` | Several costed ways to fix an event, each with its predicted sequence (the `/fixes` endpoint) |
| `what_if(facility, plan)` | Replayed tank level under a plan |
| `query_series(asset, metric, start, end)` | Raw sensor readings |
| `get_links()` | Dependency graph edges |
| `fleet_status(system)` | Trucks free and busy |

### Workflow 1: triage brief (per alert)
1. Input: one alert from `get_alerts`.
2. Agent calls `get_countdown`, `plan_system`, and `query_series` for the evidence window.
3. Output: a short operator brief (what, since when, how sure, what to do, what it costs) plus a structured block of the numbers used.
4. Low confidence: say so and name what reading would settle it.

### Workflow 2: ask the console
1. Operator types a question ("which tank trips first if S2 loses a truck?").
2. Agent picks tools, runs `what_if` or `plan_system` with the changed inputs, and answers from the results.
3. A what-if never changes the recorded data. It is a replay with a plan applied.

### Guardrails
- Every number in the output carries its source tool and value. A second check pass compares the draft to the tool outputs and rejects unsupported claims.
- Read-only. Nothing is dispatched.
- Open models call tools less reliably than large hosted ones, so validate every tool call's arguments in code and retry on a malformed call.
- If the LLM is unavailable, the console still shows alerts, countdowns, plans, and templated text.
- The agent only sees data loaded from the dataset folder, never `answer_key.json`.

### Implementation order
1. Write the tools as plain functions over the loader, detector, plan search and sim (needed for the UI anyway).
2. Thin agent layer: tool-calling loop against the open model's OpenAI-compatible endpoint on Brev (vLLM, NIM or similar), one system prompt per workflow, the tools above as function definitions.
3. Number-check pass: parse the draft's figures and match them to tool outputs.
4. Templated fallback text for when the API is unreachable.
5. Evaluate on the snapshots: does every brief's countdown and plan match the code's output exactly?

## TLDR: model plan in order

1. **Load any dataset folder.** "Now" is the last `ts_unix` in the telemetry. Never load `answer_key.json`. *(done)*
2. **Write a simulator from SPEC.md** (tank formula, pump setpoints, pressures, 92% shut-in, 6 h repairs). It writes `telemetry.csv` plus labels. *(done)*
3. **Calibrate it on the real week.** Measure noise, leak size and degradation rate from the 10 leak and worn-pump events, and check it reproduces `full_week`. *(done)*
4. **Generate thousands of random weeks.** Vary networks, timing, severity, overlapping failures and degradation-then-failure chains. *(done)*
5. **Build normalized rolling-window features** per asset (30 min, 2 h, 6 h, 24 h), so the model carries over to the unseen `test/` network. *(done)*
6. **Train LightGBM on Brev CPUs** to classify normal, leak, degradation or pump failure. Split by simulated week, not by row. *(trained once locally on 40 synthetic weeks and served by the FastAPI sidecar in `ml/`; retrain on Brev with more weeks)*
7. **Turn probabilities into events.** Smooth them, take the start and end of each run above a threshold, and use the probability as the confidence score.
8. **Add a change-point or Kalman layer only if** the trees catch slow leaks and worn pumps too late.
9. **Explain each alert with SHAP** (top three drivers as evidence), plus a shallow decision tree for readable rules in the demo.
10. **Compute the shutdown countdown with the physics formula**, not a learned model.
11. **Run the exact plan search** (trucks, early shut-ins, or do nothing), planning all ongoing failures in a system together. The backend implements this in `core/` and exposes it as `POST /fixes`, which returns several costed ways to fix each predicted event, each with its predicted sequence and cost reasoning (see "Fixing predicted events").
12. **Build the dependency graph.** Draw an edge only for a worn pump that ends at the same asset and time a failure starts, or for failures sharing a system's trucks.
13. **Serve an open-weights LLM on a Brev GPU** and wrap steps 7 to 12 as read-only tools (`get_alerts`, `get_countdown`, `plan_system`, `get_fixes`, `what_if`, `query_series`, `get_links`, `fleet_status`).
14. **Build the agent workflows, advise only:** triage briefs per alert, then ask-the-console. Every number comes from a tool result, a check pass rejects unsupported figures, and templated text covers an LLM outage. Shift handoff and replan-on-change come later.
15. **Use the LLM for text only:** the evidence wording, briefs and the shift handoff, from the structured output. It cannot create events or edges.
16. **Validate on the real folders:** `full_week`, the snapshots (alert order and countdowns), then the mock test as a dress rehearsal. Also check that every brief's countdown and plan match the code's output exactly.
