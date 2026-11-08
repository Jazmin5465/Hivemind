# ML contract: backend <-> detector

The Hivemind backend calls a small HTTP service (FastAPI, `ml/serve.py`, default `http://127.0.0.1:8001`). Status: **implemented and tested** (see "Test results" and "Changes from the draft" at the bottom).

Run it:

```
pip install -r ml/requirements.txt
python ml/serve.py            # listens on 0.0.0.0:8001
```

## Rules (all endpoints)

1. **Causal.** Every output at time t uses only telemetry with `ts_unix <= t`. This includes smoothing and any change-point or Kalman layer. Test: run once on the full data and once with `asOfUnix = T`; all outputs at times <= T must be identical (max difference 0.0).
2. **No `answer_key.json`.** The service never reads it.
3. **Held-out data.** Real folders (`full_week`, snapshots, mock test, `test/`) are never used for training.
4. **No hardcoded IDs or thresholds** tied to one network. Asset IDs come straight from `network.json` / `telemetry.csv`.
5. Works on any dataset folder (three files) with no code changes.

## GET /health

Returns `{ "status": "ok", "modelVersion": "<string>", "trainedOn": "<short description, e.g. 'synthetic v3, 2000 weeks'>" }`.

## POST /detect

Request: `{ "datasetDir": "<absolute path to folder>", "asOfUnix": <optional int> }`
(if `asOfUnix` is set, ignore all rows after it; default is the last `ts_unix`).

`datasetDir` is a path on the machine running the service, so the service and the backend must see the same folder.

Response:
```json
{
  "modelVersion": "...",
  "asOfUnix": 1760000000,
  "stepSec": 300,
  "computeMs": 1000,
  "assets": [
    {
      "assetId": "<id as in the data>",
      "assetType": "pump | pipeline",
      "tsUnix": [ ... ],
      "probs": { "normal": [ ... ], "leak": [ ... ], "degradation": [ ... ], "failure": [ ... ] }
    }
  ]
}
```
- Arrays are aligned to `tsUnix` (the 5-minute grid) and each probability row sums to 1 (within rounding, +/- 0.00001).
- Every pump and every pipeline in `network.json` gets one entry, in network order (pump, then its pipeline).
- **Pumps** return `normal`, `degradation`, `failure`. **Pipelines** return `normal`, `leak`. Classes that don't apply are omitted.
- `asOfUnix` in the response is the last timestamp actually used (the request value, or the last `ts_unix` in the data).
- The backend does the thresholding, run grouping, and event onset/end, so this returns raw per-step probabilities and no events. The service applies **no smoothing**, so the raw output is exactly the model's per-step output and is trivially causal.
- Target latency: under 5 s for one week. **Measured: about 1.4 s end to end, about 1.0 s server compute** for the 15-facility `full_week` (30 assets), on a 16-core Windows machine, cache miss. A repeat request for the same folder and `asOfUnix` is served from an in-memory cache.

### How the model's classes map to assets

The model scores each facility into four classes: normal, leak, degradation, failure. For the response:

| Asset | `normal` | other classes |
|---|---|---|
| Pump | P(normal) + P(leak) | `degradation` = P(degradation), `failure` = P(failure) |
| Pipeline | P(normal) + P(degradation) + P(failure) | `leak` = P(leak) |

So a leak shows up on the pipeline asset and not on the pump, and a pump failure shows up on the pump and not on the pipeline.

## POST /explain

Request: `{ "datasetDir": "...", "assetId": "...", "category": "pump_failure | pipeline_leak | pump_degradation", "onsetUnix": <int>, "asOfUnix": <int> }`

Response: `{ "drivers": [ { "feature": "<name>", "text": "<plain English, e.g. 'receive/pump flow ratio fell 18% over 2 h'>", "contribution": <float> } ] }` with the top 3 drivers (SHAP). Text must be readable by an operator. The LLM only rephrases it, so keep the numbers correct.

Implementation details:
- `contribution` is the SHAP value (LightGBM `pred_contrib`) toward the requested category's class, in log-odds. Larger means it pushed the model harder toward that category.
- Drivers are explained **at the latest step at or before `asOfUnix`**, not at `onsetUnix`. `onsetUnix` is accepted for the contract and not used in the computation.
- The 3 drivers come from 3 different signal families (pump state, pump flow, received flow, pipeline pressure, discharge pressure, tank level, wells), so they don't repeat the same fact.
- `assetId` may be a pump, pipeline, facility or tank id.
- Extra response fields (ignorable): `assetId`, `category`, `evaluatedAtUnix`, `probability` (the model's probability for that category at that step).
- Every number in `text` is computed from the dataset's own values for that step. Example output for a failed pump: `"The pump is in fault"`; for a leak: `"Pipeline pressure at the disposal end bottomed at 48 psi below normal over 6 hours"`, `"Water reaching the disposal site was 93.8% of what the pump sent (last 2 hours of running)"`.

## Errors

4xx/5xx with `{ "error": "<message>" }`. The backend falls back to its own rules detector when the service is down or errors, so failing loudly is fine.

| Status | When |
|---|---|
| 400 | `datasetDir` missing or lacks one of the three files, unknown `assetId`, unknown `category`, no telemetry at or before `asOfUnix` |
| 422 | malformed request body (missing or wrong-typed field) |
| 500 | anything unexpected |

## Test results

Model `lgbm-synth-fc09a1e5`, LightGBM, trained on 40 synthetic weeks (32 train / 8 validation), simulator calibrated on `full_week`.

**Truncation test** (`python ml/tests/test_truncation.py`): `/detect` on the full week versus the same with `asOfUnix = T`, everything at times <= T compared, nothing cached. Also run against a physically cut telemetry file, the organizers' real snapshot folders, and the feature table itself.

| Cut | Values compared | Features | asOfUnix | Cut file | Real snapshot folder |
|---|---|---|---|---|---|
| snapshot 10-08 12:00 | 75,675 | 0.0 | 0.0 | 0.0 | 0.0 |
| snapshot 10-09 03:30 | 89,625 | 0.0 | 0.0 | 0.0 | 0.0 |
| snapshot 10-10 09:00 | 116,175 | 0.0 | 0.0 | 0.0 | 0.0 |
| mock test 10-10 15:30 | 122,025 | 0.0 | 0.0 | 0.0 | 0.0 |
| arbitrary 10-06 17:25 | 37,350 | 0.0 | 0.0 | 0.0 | n/a |
| arbitrary 10-11 02:10 | 131,625 | 0.0 | 0.0 | 0.0 | n/a |

**Largest difference anywhere: 0.0.** The test also fails if a feature is NaN in one run and not the other.

**Detector on the real week** (`python ml/eval/eval_real.py Resources/full_week`, evaluation only, thresholds are the eval script's own: probability > 0.5 for at least 3 consecutive steps): 23 of 23 events detected, 0 false-alarm runs. Delay after onset: pump failures 0 minutes, leaks 5 minutes to 1 hour, worn pumps 1.8 to 2.5 hours. Caveat: `full_week` was never trained on but the simulator's parameters were fitted to it, so this is not a fully independent test. The mock test and the unseen `test/` folder are the independent checks.

Validation on held-out synthetic weeks, per row: failure precision/recall 1.00/1.00, leak 0.97/0.97, degradation 0.99/0.90, normal 0.99/1.00.

## Changes from the draft

Everything outside the Rules section; the Rules section is unchanged.

1. **Default URL is `http://127.0.0.1:8001`, not `localhost`.** On Windows, `localhost` resolves to IPv6 first and added about 2.1 s per request. macOS should not show this, but `127.0.0.1` is safe everywhere.
2. **`/detect` mapping** from the model's four classes to pump and pipeline assets is spelled out (table above). A leak's probability sits on the pipeline asset; the pump's `normal` includes it.
3. **`/detect` response** gained one optional field, `computeMs`. `asOfUnix` in the response is the last timestamp used.
4. **No smoothing** inside the service (so nothing extra to keep causal).
5. **`/explain`**: drivers are evaluated at the latest step at or before `asOfUnix`; `onsetUnix` is accepted and not used; drivers come from different signal families; four extra optional response fields; `contribution` is SHAP log-odds toward the category.
6. **Errors**: status codes defined (400 / 422 / 500).
7. **Latency measured**: about 1.4 s end to end, about 1.0 s compute, for one week.
8. **Test results and run instructions** added.

## LLM endpoint (from Hadent, since he owns Brev)

**Status: not provisioned yet.** No Brev instance exists as of this writing, so there is no base URL, and I won't make one up. What is decided, and what is open:

| Item | Value |
|---|---|
| Base URL | **TBD** once the instance is up. Format will be `http://<host>:8000/v1` (vLLM's default port is 8000) |
| Served model name | `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-FP8` (per the vLLM recipe; confirm the exact id on Hugging Face when pulling) |
| Tool calling | Planned on, with `--enable-auto-tool-choice --tool-call-parser qwen3_coder` (the recipe's setting) |
| Reasoning parser | Planned on: `--reasoning-parser-plugin nano_v3_reasoning_parser.py --reasoning-parser nano_v3` (the recipe downloads the plugin file from the model's Hugging Face repo). An older vLLM blog used `deepseek_r1`; the recipe is the more current source |
| FP8 KV cache | `--kv-cache-dtype fp8`, only valid with the FP8 checkpoint |
| Auth | start vLLM with `--api-key <secret>`; the key goes in `.env` as `LLM_API_KEY`, never in the repo |
| GPU | **TBD.** The FP8 weights alone are roughly 30 GB, so it needs a GPU with comfortably more than that (48 to 80 GB class) |

**How another machine reaches it** (open decision). A `brev port-forward` is localhost-only on the machine that runs it. Options:
1. Run `brev port-forward <instance> --port 8000:8000` **on the backend machine itself**. Works, but whoever runs it needs Brev CLI access to the instance, and the tunnel must stay up.
2. A Brev console tunnel gives a public URL, but the docs say it goes through Cloudflare and asks for browser sign-in on first use, which doesn't suit a server-to-server client.
3. Open the port in the instance's access settings, ideally restricted to the backend machine's IP, and always with `--api-key`. I have not verified the exact setting.

Recommendation: option 1 if the backend machine can have the Brev CLI, otherwise option 3. Until it is up, use `LLM_PROVIDER=nvidia_hosted` or `template`, as the backend spec says.
