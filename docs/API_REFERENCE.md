# ML sidecar API reference

Every endpoint of the Hivemind ML sidecar, with a real request, a real response and the meaning of every field. All examples below were captured from the running service on the organizers' practice data.

- **Service:** FastAPI app in `ml/serve.py`
- **Base URL:** `http://127.0.0.1:8001` (use `127.0.0.1`, not `localhost`: on Windows `localhost` adds about 2 s per request)
- **Format:** JSON in, JSON out, UTF-8
- **Interactive docs:** `http://127.0.0.1:8001/docs` (FastAPI's built-in page; see the note on `/detect` below)
- **How to test step by step:** [API_TESTING.md](API_TESTING.md)
- **Backend contract and test results:** [ML_CONTRACT.md](ML_CONTRACT.md)

## Contents

1. [Common concepts](#1-common-concepts)
2. [GET /health](#2-get-health)
3. [POST /detect](#3-post-detect)
4. [POST /explain](#4-post-explain)
5. [POST /fixes](#5-post-fixes)
6. [POST /fixes/all](#6-post-fixesall)
7. [Errors](#7-errors)
8. [Glossary](#8-glossary)

---

## 1. Common concepts

### The dataset folder (`datasetDir`)

Every POST endpoint takes `datasetDir`: the **absolute path** to a folder on the machine running the service that contains the organizers' three files:

| File | Contents |
|---|---|
| `network.json` | Systems, facilities, wells, tanks, pumps, pipelines, tank limits |
| `ops.json` | Prices, repair time, truck capacity and cost, fleet sizes, truck travel times |
| `telemetry.csv` | Every sensor reading, every 5 minutes |

The service reads the folder from its own disk; you do not upload files. On Windows use forward slashes (`C:/Users/...`) or doubled backslashes (`C:\\Users\\...`) inside JSON.

The service never reads `answer_key.json`, even if the folder contains one.

### Time

- All times are **unix seconds, UTC** (seconds since 1970-01-01 00:00 UTC). Example: `1791460800` = 2026-10-08 12:00 UTC.
- The data is on a **5-minute grid** (`stepSec` = 300).
- **"Now"** is the last reading in `telemetry.csv`, never the computer's clock.
- **`asOfUnix`** (optional on every POST) makes the service act as if "now" were that time: rows after it are ignored before anything is computed. This is how time travel works. Outputs at a time T are identical whether you send the full data or cut it at T (tested: largest difference 0.0).
  - Later than the last reading: the last reading is used, and the response's `asOfUnix` says which time was used.
  - Earlier than the first reading: 400 error.

### Asset IDs

IDs come straight from `network.json`. In the practice network they look like `S2_PUMP_B` (system 2, facility B's pump), `S2_PIPELINE_B`, `S2_FACILITY_B`, `S2_WELL_B1`. A different network has different IDs; nothing is hardcoded.

### Problem categories

| Category | Asset | Meaning | Repo's action |
|---|---|---|---|
| `pump_failure` | pump | Pump stopped; the tank fills toward its shutdown limit | Cheapest plan: trucks, early well shut-ins, or let it trip |
| `pump_degradation` | pump | Pump wearing out: moves a little less water every hour | Send an inspector |
| `pipeline_leak` | pipeline | Water escapes between the pump and the disposal site | Send an inspector (urgent) |

### Event IDs

`/fixes` and `/fixes/all` identify an ongoing problem as `category:assetId:onsetUnix`, for example `pump_failure:S4_PUMP_C:1791511200`. This is the same format the backend's `event` table uses.

---

## 2. GET /health

Is the service up, and which model is loaded. The backend uses this to decide between the ML detector and its own rules fallback.

### Request

No body.

```bash
curl http://127.0.0.1:8001/health
```

### Response (200)

```json
{
  "status": "ok",
  "modelVersion": "lgbm-synth-fc09a1e5",
  "trainedOn": "synthetic: 40 simulated weeks (32 train, 8 validation), simulator calibrated on full_week"
}
```

| Field | Type | Meaning |
|---|---|---|
| `status` | string | Always `"ok"` when the service answers |
| `modelVersion` | string | ID of the loaded LightGBM model. `lgbm-synth-` plus the first 8 hex digits of the model file's hash. Changes whenever the model is retrained |
| `trainedOn` | string | Human-readable description of the training data |

---

## 3. POST /detect

**The ML model's prediction.** Runs the LightGBM detector over the dataset and returns, for every pump and every pipeline, the probability of each problem at every 5-minute step.

It returns probabilities only, not alerts. Turning probabilities into alerts (threshold, how long, onset, end) is the caller's job; the backend and `/fixes/all` each do this.

### Request

```json
{
  "datasetDir": "C:/Users/Hadent/Desktop/Hack/hackutd/Hivemind/data/eog/snapshot_2026-10-09T0330",
  "asOfUnix": 1791516600
}
```

| Field | Type | Required | Meaning |
|---|---|---|---|
| `datasetDir` | string | yes | Absolute path to the dataset folder |
| `asOfUnix` | integer | no | Act as if "now" were this time. Default: the last reading |

### Response (200)

Trimmed to 2 of the 30 assets and the last 3 of 1,195 steps. This is the snapshot at 10-09 03:30, where S4_PUMP_C has been failed since 02:00:

```json
{
  "modelVersion": "lgbm-synth-fc09a1e5",
  "asOfUnix": 1791516600,
  "stepSec": 300,
  "computeMs": 534,
  "assets": [
    {
      "assetId": "S4_PUMP_C",
      "assetType": "pump",
      "tsUnix": [1791516000, 1791516300, 1791516600],
      "probs": {
        "normal":      [0.00028, 0.00028, 0.00028],
        "degradation": [0.00066, 0.00066, 0.00065],
        "failure":     [0.99906, 0.99906, 0.99907]
      }
    },
    {
      "assetId": "S4_PIPELINE_C",
      "assetType": "pipeline",
      "tsUnix": [1791516000, 1791516300, 1791516600],
      "probs": {
        "normal": [0.99994, 0.99994, 0.99994],
        "leak":   [0.00006, 0.00006, 0.00006]
      }
    }
  ]
}
```

#### Top-level fields

| Field | Type | Meaning |
|---|---|---|
| `modelVersion` | string | Model that produced these numbers (same as `/health`) |
| `asOfUnix` | integer | The "now" actually used: the last time step in the arrays |
| `stepSec` | integer | Seconds between steps. Always 300 |
| `computeMs` | integer | Server time for this request, in ms. Informational; safe to ignore |
| `assets` | array | One entry per pump and per pipeline in `network.json` |

#### Each entry in `assets`

| Field | Type | Meaning |
|---|---|---|
| `assetId` | string | Pump or pipeline ID from `network.json` |
| `assetType` | string | `"pump"` or `"pipeline"` |
| `tsUnix` | array of integers | Time of each step (unix seconds, UTC), oldest first, from the first reading to `asOfUnix`. Identical for every asset |
| `probs` | object | One array per class, each the same length as `tsUnix` |

#### The `probs` object

| Asset type | Key | Meaning |
|---|---|---|
| pump | `normal` | Probability the pump is fine at that step (a leak on its pipeline counts as fine for the pump) |
| pump | `degradation` | Probability the pump is wearing out |
| pump | `failure` | Probability the pump has failed |
| pipeline | `normal` | Probability the pipeline is fine |
| pipeline | `leak` | Probability the pipeline is leaking |

How to read them:
- **Position `i` in every array is the same moment:** `probs.failure[i]` is the failure probability at `tsUnix[i]`. The last element is the prediction at "now".
- **Each step sums to 1** (within rounding). Values are rounded to 5 decimal places, so very small values may appear as `6e-05`.
- **Order of `assets`:** facility by facility, in `network.json` order; each facility's pump comes first, then its pipeline. The practice network has 15 facilities, so 30 assets.
- **Causal:** the value at step `i` uses only readings at or before `tsUnix[i]`.
- **Turning it into alerts:** the backend (`core/src/mlEvents.ts`) opens a pump-failure alert after 3 steps (15 minutes) above 0.5, a leak or worn-pump alert after 6 steps (30 minutes) above 0.5, and closes an alert after 3 steps below 0.5. These rules belong to the caller, not to this endpoint.

#### Size and the `/docs` page

A full week is about 2 MB of JSON (30 assets x 2,016 steps x 2 to 3 classes). The interactive `/docs` page tries to display and colour the whole response and can freeze the browser tab. The server answers in well under a second; use PowerShell, `curl` or a script to look at `/detect` results (examples in [API_TESTING.md](API_TESTING.md)).

---

## 4. POST /explain

**Why the model flagged an alert.** Returns the 3 input signals that pushed the model hardest toward a category at a given moment, in plain English with the actual numbers. Computed with SHAP values from LightGBM.

### Request: a failed pump

```json
{
  "datasetDir": "C:/Users/Hadent/Desktop/Hack/hackutd/Hivemind/data/eog/snapshot_2026-10-09T0330",
  "assetId": "S4_PUMP_C",
  "category": "pump_failure",
  "onsetUnix": 1791511200,
  "asOfUnix": 1791516600
}
```

| Field | Type | Required | Meaning |
|---|---|---|---|
| `datasetDir` | string | yes | Absolute path to the dataset folder |
| `assetId` | string | yes | Pump, pipeline, facility or tank ID. All four resolve to the same facility |
| `category` | string | yes | `pump_failure`, `pump_degradation` or `pipeline_leak` |
| `onsetUnix` | integer | yes | When the alert started. Accepted for the backend contract; **not used in the calculation** |
| `asOfUnix` | integer | no | The moment to explain. Default: the last reading |

Take `assetId`, `category` and `onsetUnix` from an existing alert (the backend's `event` table, or the `events` list of `/fixes/all`).

### Response (200)

```json
{
  "drivers": [
    { "feature": "pump_status",    "text": "The pump is in fault", "contribution": 7.6695 },
    { "feature": "flow_age_h",     "text": "The pump last ran 1.6 hours ago, so the latest pump flow reading is that old", "contribution": 0.0969 },
    { "feature": "level_to_limit", "text": "The tank is 22.5 percentage points below its shutdown limit", "contribution": 0.0578 }
  ],
  "assetId": "S4_PUMP_C",
  "category": "pump_failure",
  "evaluatedAtUnix": 1791516600,
  "probability": 0.9991
}
```

### Another example: a leak

Request `{"datasetDir": ".../snapshot_2026-10-08T1200", "assetId": "S5_PIPELINE_B", "category": "pipeline_leak", "onsetUnix": 1791439800}` returns:

```json
{
  "drivers": [
    { "feature": "pipe_min_6h",    "text": "Pipeline pressure at the disposal end bottomed at 36 psi below normal over 6 hours", "contribution": 2.7511 },
    { "feature": "ratio_mean_30m", "text": "Water reaching the disposal site averaged 96.5% of what the pump sent over the last 30 minutes", "contribution": 0.7781 },
    { "feature": "pump_status",    "text": "The pump is running", "contribution": 0.0507 }
  ],
  "assetId": "S5_PIPELINE_B",
  "category": "pipeline_leak",
  "evaluatedAtUnix": 1791460800,
  "probability": 0.9994
}
```

#### Response fields

| Field | Type | Meaning |
|---|---|---|
| `drivers` | array | The top 3 reasons, strongest first |
| `drivers[].feature` | string | Internal name of the model input (for developers; see the families table below) |
| `drivers[].text` | string | Plain-English sentence for operators. Every number in it is the dataset's own value at that step |
| `drivers[].contribution` | number | SHAP value toward the requested category, in log-odds. Bigger means it pushed the model harder toward that category. Only meaningful compared with the other drivers |
| `assetId` | string | Echo of the request |
| `category` | string | Echo of the request |
| `evaluatedAtUnix` | integer | The step that was explained: the latest step at or before `asOfUnix` |
| `probability` | number | The model's probability for that category at that step (0 to 1) |

#### How the 3 drivers are chosen

The model has 58 inputs. They are grouped into families, and only the strongest input of each family can appear, so the 3 drivers never repeat the same fact:

| Family | Example features | What it measures |
|---|---|---|
| pump state | `pump_status`, `pump_fault`, `status_hours` | Pump status (0 stopped, 1 running, 2 fault) and how long it has been in it |
| pump flow | `flow_mean_30m`, `flow_chg_6h`, `flow_age_h` | Pump flow as a fraction of its rated flow; worn pumps lose flow |
| received flow | `ratio_mean_30m`, `ratio_carried`, `loss_pipe_vs_pump` | Water reaching the disposal site / water the pump sent; leaks lower it |
| pipeline pressure | `pipe_min_6h`, `pipe_mean_2h`, `off_press_dev_2h` | Pressure at the disposal end versus normal; leaks lower it |
| discharge pressure | `dis_mean_30m`, `dis_chg_6h` | Pump outlet pressure versus normal; worn pumps lower it |
| tank level | `level_pct`, `level_to_limit`, `level_slope_2h` | How full the tank is and how fast it moves |
| wells | `well_frac_now`, `wells_on_frac` | Water arriving from the wells, and how many are producing |

Suffixes: `_30m`, `_2h`, `_6h`, `_24h` are trailing time windows; `_mean_` averages, `_chg_` change versus the previous window, `_min_6h` lowest 6-hour value, `_carried` last value while the pump was running, `_age_h` hours since the pump last ran.

#### Note

`/explain` does not check that an alert exists. Called on a healthy asset, it still returns 3 drivers, describing whatever nudged a tiny probability. Only call it for real alerts.

---

## 5. POST /fixes

**Several costed ways to fix one ongoing problem**, each with a timeline of what happens next and how the cost was worked out.

How it works:
1. Loads the data up to "now" and runs the ML detector (same as `/detect`).
2. Finds problems still ongoing at "now": a pump failure above 0.5 for 15 minutes, a leak or worn pump above 0.5 for 30 minutes (dips of up to 30 minutes are joined).
3. Picks the one you asked for.
4. **Pump failure:** runs the backend's own planner (`core/src/planner.ts`, through `ml/fixes/bridge.ts`) for the whole system, because tanks in a system share the truck fleet. Costs therefore match the console's plans.
5. **Leak or worn pump:** builds an "inspect now" fix and a "monitor" fix with a projection of the trend measured on that asset.

### Request

```json
{
  "datasetDir": "C:/Users/Hadent/Desktop/Hack/hackutd/Hivemind/data/eog/snapshot_2026-10-09T0330",
  "assetId": "S4_PUMP_C"
}
```

| Field | Type | Required | Meaning |
|---|---|---|---|
| `datasetDir` | string | yes | Absolute path to the dataset folder |
| `eventId` | string | one of `eventId` / `assetId` | `category:assetId:onsetUnix`. If the onset differs by a few minutes, the same category and asset still match |
| `assetId` | string | one of `eventId` / `assetId` | Pump, pipeline or facility ID. Picks the ongoing problem on that asset (a pump failure first if there are several) |
| `asOfUnix` | integer | no | Plan as if "now" were this time. Default: the last reading |
| `overrides` | object | no | What-if changes to the planning inputs (table below). They never change the data |
| `maxFixes` | integer | no | Most fixes to return. Default 4 |

#### `overrides`

All optional. Pump failures only; ignored for leaks and worn pumps.

| Key | Type | Meaning | Example |
|---|---|---|---|
| `fleetSize` | integer | Trucks the system has | `{"fleetSize": 1}`: "what if we lose a truck?" |
| `noTrucks` | boolean | No trucks available at all | `{"noTrucks": true}` |
| `extraRepairHours` | number | Repair takes this many hours longer | `{"extraRepairHours": 2}` |
| `repairHours` | number | Replace the repair time (hours from onset) | `{"repairHours": 8}` |
| `lockedWells` | array of strings | Wells that may not be shut in | `{"lockedWells": ["S4_WELL_C1"]}` |
| `truckCapacityBbl` | number | Barrels removed per truck trip | `{"truckCapacityBbl": 200}` |
| `costPerTrip` | number | Dollars per truck trip | `{"costPerTrip": 1000}` |

Any other key returns a 400 error listing the allowed ones.

### Response (200): a failed pump

At 10-09 03:30, S4_PUMP_C has been failed since 02:00, its tank is about 70% full and rising, and the repair ends at 08:00:

```json
{
  "eventId": "pump_failure:S4_PUMP_C:1791511200",
  "fixes": [
    {
      "fixDescription": "Recommended (cheapest for the whole system): Send 2 trucks to S4_FACILITY_C now for 1 trip each.",
      "predictedSequence": [
        "2026-10-09T05:00Z - 2 trucks arrive and remove 300 bbl; tank drops from 84.1% to 50.7%",
        "2026-10-09T08:00Z - Repair completes and the pump restarts; tank peaked at 84.1%, below the 92% shutdown limit",
        "2026-10-09T08:50Z - 2 trucks back at the yard and free for other jobs in S4"
      ],
      "cost": 1810,
      "costReasoning": "2 trucks x 1 trip x $905 per trip = $1,810. Each trip removes 150 bbl; the first arrives 90 min after the call and each truck returns every 230 min. Total: $1,810."
    },
    {
      "fixDescription": "Shut in wells only: Shut in S4_WELL_C1 at 03:37 UTC (7 min from now) until the repair ends.",
      "predictedSequence": [
        "2026-10-09T03:37Z - S4_WELL_C1 shut in (1,050 bbl/day of water stops); tank is at 70.3%",
        "2026-10-09T06:35Z - Tank crosses the 85% warning level (about)",
        "2026-10-09T08:00Z - Repair completes, the pump restarts and S4_WELL_C1 is turned back on; tank peaked at 91.94%, below the 92% shutdown limit"
      ],
      "cost": 4520.31,
      "costReasoning": "S4_WELL_C1: 350 bbl oil x $60 + 1,250 mcf gas x $3 = $24,750 a day = $1,031.25 an hour. Off from 03:37 to 08:00 = 4.38 h, so $1,031.25 x 4.38 h = $4,520.31 of lost oil and gas sales. 03:37 is the latest start that still keeps the tank under the limit. Total: $4,520.31."
    },
    {
      "fixDescription": "Do nothing and let the tank trip; all wells shut in automatically until the repair ends.",
      "predictedSequence": [
        "2026-10-09T05:10Z - Tank crosses the 85% warning level (about)",
        "2026-10-09T05:48Z - Tank reaches the 92% shutdown limit; all 3 wells shut in automatically, losing $3,450 an hour",
        "2026-10-09T08:00Z - Repair completes; the pump restarts and the wells resume"
      ],
      "cost": 7540.71,
      "costReasoning": "Automatic shut-in from 05:48 to 08:00 = 2.19 h. Lost revenue per hour is the sum over the facility's wells (S4_WELL_C1 $1,031.25, S4_WELL_C2 $1,031.25, S4_WELL_C3 $1,387.50) = $3,450, so $3,450 x 2.19 h = $7,540.71. Total: $7,540.71."
    }
  ]
}
```

The recommended $1,810 matches the answer key for this snapshot.

#### Response fields

The response always has exactly these fields and no others.

| Field | Type | Meaning |
|---|---|---|
| `eventId` | string | The problem these fixes are for, `category:assetId:onsetUnix` |
| `fixes` | array | The ways to fix it (see order below) |
| `fixes[].fixDescription` | string | What to do, in one or two sentences. Starts with a label: `Recommended (cheapest for the whole system):`, `Trucks only:`, `Shut in wells only:`, or none for "do nothing". When other tanks in the system are also failing, the recommended fix says how many trucks go to them |
| `fixes[].predictedSequence` | array of strings | What is expected to happen after this fix, oldest first. Each entry is `"<UTC time> - <what happens>"` (time format `YYYY-MM-DDTHH:MMZ`). See below |
| `fixes[].cost` | number | Total cost of this fix in US dollars. 0 for leaks and worn pumps means **unpriced**, not free |
| `fixes[].costReasoning` | string | The formula with its inputs. For pump failures it ends with `Total: $X.`, which always equals `cost` |

#### Which fixes, in which order (pump failure)

1. **Recommended:** this tank's part of the cheapest plan for the whole system. All ongoing failures in the system are planned together because they share the trucks.
2. **Trucks only:** the cheapest plan using trucks alone.
3. **Shut in wells only:** the cheapest plan using early well shut-ins alone. Shut-ins start as late as possible, because every minute a well stays on is revenue kept.
4. **Do nothing:** let the tank reach its shutdown limit; all the facility's wells stop until the repair.

Fixes 2 to 4 keep the other failing tanks on their recommended plans, so they can only use trucks those plans leave free. They are sorted by cost after the recommended one. A fix is left out when it is identical to another, when no trucks are free (no "trucks only"), or when trucks alone cannot stop the trip.

Special cases:
- **The tank never reaches the limit before the repair:** one fix, "No action needed", cost 0.
- **The tank is already at the limit:** one fix, wait for the repair; cost is the remaining lost revenue.

#### What appears in `predictedSequence`

| Entry | When it appears | Example |
|---|---|---|
| Truck arrival | Each trip | `2 trucks arrive and remove 300 bbl; tank drops from 84.1% to 50.7%` |
| Wells shut in | When a shut-in starts | `S4_WELL_C1 shut in (1,050 bbl/day of water stops); tank is at 70.3%` |
| Warning level | Tank rises past the warning limit before the repair. Time is to the nearest 5 minutes | `Tank crosses the 85% warning level (about)` |
| Already above warning | The tank starts above the warning limit | `Tank is already above the 85% warning level (89.7%)` |
| Shutdown | The tank reaches the shutdown limit | `Tank reaches the 92% shutdown limit; all 3 wells shut in automatically, losing $3,450 an hour` |
| Repair end | Always | `Repair completes and the pump restarts; tank peaked at 84.1%, below the 92% shutdown limit` |
| Trucks free | After the last trip, one cycle later. Tells the next failure in the system how many trucks it will find | `2 trucks back at the yard and free for other jobs in S4` |

Limits (85% and 92% here), prices, truck capacity, travel times and repair time all come from the dataset's `network.json` and `ops.json`.

### Example: what-if with one truck

Same request plus `"overrides": {"fleetSize": 1}`. One truck alone cannot stop the trip, so the recommended fix becomes a truck plus a late shut-in, and "trucks only" disappears:

```json
{
  "eventId": "pump_failure:S4_PUMP_C:1791511200",
  "fixes": [
    {
      "fixDescription": "Recommended (cheapest for the whole system): Send 1 truck to S4_FACILITY_C now for 1 trip and shut in S4_WELL_C1 at 07:03 UTC (213 min from now) until the repair ends.",
      "predictedSequence": [
        "2026-10-09T05:00Z - 1 truck arrives and removes 150 bbl; tank drops from 84.1% to 67.4%",
        "2026-10-09T06:50Z - Tank crosses the 85% warning level (about)",
        "2026-10-09T07:03Z - S4_WELL_C1 shut in (1,050 bbl/day of water stops); tank is at 86.9%",
        "2026-10-09T08:00Z - Repair completes, the pump restarts and S4_WELL_C1 is turned back on; tank peaked at 91.97%, below the 92% shutdown limit",
        "2026-10-09T08:50Z - 1 truck back at the yard and free for other jobs in S4"
      ],
      "cost": 1884.69,
      "costReasoning": "1 truck x 1 trip x $905 per trip = $905. Each trip removes 150 bbl; the first arrives 90 min after the call and each truck returns every 230 min. S4_WELL_C1: 350 bbl oil x $60 + 1,250 mcf gas x $3 = $24,750 a day = $1,031.25 an hour. Off from 07:03 to 08:00 = 0.95 h, so $1,031.25 x 0.95 h = $979.69 of lost oil and gas sales. 07:03 is the latest start that still keeps the tank under the limit. Total: $1,884.69."
    },
    { "fixDescription": "Shut in wells only: ...", "cost": 4520.31, "...": "same as above" },
    { "fixDescription": "Do nothing ...", "cost": 7540.71, "...": "same as above" }
  ]
}
```

### Example: tanks sharing trucks

`{"datasetDir": ".../snapshot_2026-10-08T1200", "eventId": "pump_failure:S2_PUMP_C:1791451800"}`. Three S2 pumps have failed and S2 has 2 trucks. Both go to the other tanks, so this tank's recommended fix is a shut-in ($1,298.33, matching the answer key), and "trucks only" is left out because no trucks are free. The recommended fix's description ends with `Planned together with 2 other failing tanks in S2: 2 of 2 trucks go to them.`

### Example: a leak

`{"datasetDir": ".../snapshot_2026-10-08T1200", "assetId": "S5_PIPELINE_B"}` returns:

```json
{
  "eventId": "pipeline_leak:S5_PIPELINE_B:1791439800",
  "fixes": [
    {
      "fixDescription": "Send an inspector to S5_PIPELINE_B now (pipeline leak). The pump still moves water, so no trucks or shut-ins are needed.",
      "predictedSequence": [
        "2026-10-08T12:00Z - Inspector dispatched to S5_PIPELINE_B at S5_FACILITY_B",
        "After the repair - water reaching the disposal site returns to what the pump sends, and pipeline pressure returns to normal"
      ],
      "cost": 0,
      "costReasoning": "ops.json has no price for a field inspection and no inspector travel time, so the cost is shown as 0. That means unpriced, not free."
    },
    {
      "fixDescription": "No action yet: monitor S5_PIPELINE_B (pipeline leak). The projection extrapolates the trend measured on this asset since the onset.",
      "predictedSequence": [
        "2026-10-08T12:00Z - About 3.7% of the pumped water is not reaching the disposal site, growing 0.39 points an hour",
        "2026-10-09T00:00Z - Projected loss about 8.4% of pumped water if the trend holds",
        "2026-10-09T12:00Z - Projected loss about 13.0% of pumped water if the trend holds"
      ],
      "cost": 0,
      "costReasoning": "ops.json has no price for monitoring or an inspection and no inspector travel time, so the cost is shown as 0. That means unpriced, not free."
    }
  ]
}
```

Leak and worn-pump specifics:
- A leak or worn pump does not fill the tank (the pump still moves water), so there is no countdown and no trucks.
- Entries without a known time start with a label instead, such as `After the repair -` or `Risk -`.
- **Leak projection:** fits a straight line through the share of pumped water lost (1 - received flow / pump flow) at every running step since the onset, then extends it 12 and 24 hours (capped at 90%).
- **Worn pump projection:** fits a line through pump flow as a fraction of rated flow, and gives the time it falls below the wells' inflow. After that the tank fills even while the pump runs, so a shutdown becomes possible. It also adds `Risk - a worn pump can go on to fail outright, which would start a shutdown countdown`.
- With less than 30 minutes of running data since the onset, the projection says it can't project yet.

---

## 6. POST /fixes/all

`/fixes` for every ongoing problem at once, plus the list of those problems. Good for a dashboard or a shift summary.

### Request

```json
{
  "datasetDir": "C:/Users/Hadent/Desktop/Hack/hackutd/Hivemind/data/eog/snapshot_2026-10-09T0330"
}
```

| Field | Type | Required | Meaning |
|---|---|---|---|
| `datasetDir` | string | yes | Absolute path to the dataset folder |
| `asOfUnix` | integer | no | Act as if "now" were this time |
| `overrides` | object | no | Same as `/fixes`; applied to every pump failure |
| `maxFixes` | integer | no | Most fixes per event. Default 4 |

### Response (200)

```json
{
  "asOfUnix": 1791516600,
  "events": [
    {
      "eventId": "pump_failure:S4_PUMP_C:1791511200",
      "category": "pump_failure",
      "assetId": "S4_PUMP_C",
      "facilityId": "S4_FACILITY_C",
      "systemId": "S4",
      "onsetUnix": 1791511200,
      "confidence": 0.9985
    },
    {
      "eventId": "pipeline_leak:S5_PIPELINE_B:1791439800",
      "category": "pipeline_leak",
      "assetId": "S5_PIPELINE_B",
      "facilityId": "S5_FACILITY_B",
      "systemId": "S5",
      "onsetUnix": 1791439800,
      "confidence": 0.997
    }
  ],
  "results": [
    { "eventId": "pump_failure:S4_PUMP_C:1791511200", "fixes": [ "... same as the /fixes example ..." ] },
    { "eventId": "pipeline_leak:S5_PIPELINE_B:1791439800", "fixes": [ "... inspect now / monitor ..." ] }
  ]
}
```

| Field | Type | Meaning |
|---|---|---|
| `asOfUnix` | integer | The "now" used |
| `events` | array | Every problem ongoing at "now", pump failures first, then by onset |
| `events[].eventId` | string | `category:assetId:onsetUnix`; pass it to `/fixes` or match it to the backend's events |
| `events[].category` | string | `pump_failure`, `pipeline_leak` or `pump_degradation` |
| `events[].assetId` | string | The pump or pipeline with the problem |
| `events[].facilityId` | string | Its facility |
| `events[].systemId` | string | Its system (failures in one system share trucks) |
| `events[].onsetUnix` | integer | When the model first flagged it (unix seconds, UTC) |
| `events[].confidence` | number | Mean model probability over the alert so far (0 to 1) |
| `results` | array | One `/fixes` response per event, in the same order as `events` |

---

## 7. Errors

Every error has a JSON body with one field:

```json
{ "error": "<what went wrong>" }
```

| Status | When | Real example message |
|---|---|---|
| 400 | `datasetDir` missing or lacks a file | `datasetDir not found: C:/nope` |
| 400 | `asOfUnix` before the first reading | `no telemetry rows at or before asOfUnix` |
| 400 | `/fixes`: neither `eventId` nor `assetId` | `give eventId or assetId` |
| 400 | `/fixes`: no ongoing problem there at that time | `no ongoing event on 'S1_PUMP_A' at this time` |
| 400 | `/fixes`: unknown override key | `unknown overrides ['trucks']; allowed: ['costPerTrip', 'extraRepairHours', 'fleetSize', 'lockedWells', 'noTrucks', 'repairHours', 'truckCapacityBbl']` |
| 400 | `/explain`: unknown category | `unknown category 'fire'; use one of ['pipeline_leak', 'pump_degradation', 'pump_failure']` |
| 400 | `/explain`: unknown asset | `assetId 'NOPE' not found in network.json` |
| 422 | Missing or wrong-typed field in the body | `body.datasetDir: Field required` |
| 500 | Anything unexpected, including the planner bridge failing (for example Node not installed) | ``RuntimeError: planner bridge exited; check that `npm install` was run in the repo`` |

The backend falls back to its own rules detector when the service is down or errors.

---

## 8. Glossary

| Term | Meaning |
|---|---|
| bbl | Barrel, 42 US gallons |
| bpd | Barrels per day |
| mcf | Thousand cubic feet of gas |
| psi | Pounds per square inch (pressure) |
| Shut in | Turn a well off. It produces no water, oil or gas, so it earns nothing |
| Warning / shutdown limit | Tank fill levels from `network.json` (85% and 92% in the practice data). At shutdown all the facility's wells shut in automatically |
| Trip | The tank reaching its shutdown limit |
| Disposal site | Where a system's pipelines end and the water goes underground |
| Truck trip | One truck visit: removes `truck_capacity_bbl` and costs `cost_per_trip`. The first arrives `response_min` after the call, then one every `cycle_min` |
| Repair time | `expected_repair_hours.pump_failure` from onset (6 h in the practice data) |
| SHAP value | How much one input moved the model's output for one prediction |
