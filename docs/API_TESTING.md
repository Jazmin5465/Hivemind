# Testing the ML sidecar API

The sidecar is a FastAPI service in `ml/serve.py` on `http://127.0.0.1:8001`. Full request and response shapes are in [ML_CONTRACT.md](ML_CONTRACT.md).

| Endpoint | What it does |
|---|---|
| `GET /health` | Is the service up, and which model is loaded |
| `POST /detect` | Per-step probabilities for every pump and pipeline |
| `POST /explain` | The top 3 reasons behind one alert |
| `POST /fixes` | Several costed ways to fix one ongoing event |
| `POST /fixes/all` | `/fixes` for every ongoing event at once |

## 1. Start it

From the repo root:

```bash
pip install -r ml/requirements.txt
npm install
python ml/serve.py
```

`npm install` is needed because `/fixes` runs the backend's planner through Node. Leave the window open. You can also start it with `npm run ml` (on Windows: `ML_PY=python npm run ml` in Git Bash).

You need dataset folders in `data/eog/` (gitignored). `npm run data:fetch` downloads them.

## 2. Easiest: the built-in docs page

Open **http://127.0.0.1:8001/docs** in a browser. Click an endpoint, then **Try it out**, paste a request body, and click **Execute**. You see the response right there.

Example body for `/fixes` (change the path to your own folder; forward slashes work on Windows too):

```json
{
  "datasetDir": "C:/Users/you/Hivemind/data/eog/snapshot_2026-10-08T1200",
  "assetId": "S2_PUMP_B"
}
```

## 3. From PowerShell (Windows)

Run these from the repo root. The first line builds the dataset path for you.

```powershell
$ds = "$((Get-Location).Path -replace '\\','/')/data/eog/snapshot_2026-10-08T1200"
$api = "http://127.0.0.1:8001"
function Post($path, $body) { Invoke-RestMethod -Method Post -Uri "$api$path" -ContentType "application/json" -Body ($body | ConvertTo-Json -Depth 5) }
```

Health:
```powershell
Invoke-RestMethod "$api/health"
```

Detect (it returns a lot of numbers, so this prints a summary):
```powershell
$d = Post "/detect" @{ datasetDir = $ds }
"$($d.assets.Count) assets, $($d.assets[0].tsUnix.Count) steps, model $($d.modelVersion), $($d.computeMs) ms"
```

Explain one alert:
```powershell
(Post "/explain" @{ datasetDir = $ds; assetId = "S2_PUMP_B"; category = "pump_failure"; onsetUnix = 1791450000 }).drivers | Format-Table feature, contribution, text -Wrap
```

Fixes for one event:
```powershell
$f = Post "/fixes" @{ datasetDir = $ds; assetId = "S2_PUMP_B" }
$f.eventId
$f.fixes | ForEach-Object { "`n`$$($_.cost)  $($_.fixDescription)"; $_.predictedSequence | ForEach-Object { "    $_" } }
```

What-if, only 1 truck in the system:
```powershell
(Post "/fixes" @{ datasetDir = $ds; assetId = "S2_PUMP_B"; overrides = @{ fleetSize = 1 } }).fixes[0] | Format-List cost, fixDescription
```

Every ongoing event:
```powershell
$all = Post "/fixes/all" @{ datasetDir = $ds }
$all.events | Format-Table eventId, category, confidence
```

See the raw JSON exactly as the API sends it:
```powershell
(Invoke-WebRequest -Method Post -Uri "$api/fixes" -ContentType "application/json" -Body (@{ datasetDir = $ds; assetId = "S2_PUMP_B" } | ConvertTo-Json)).Content
```

## 4. From a Mac or Linux terminal

```bash
DS="$(pwd)/data/eog/snapshot_2026-10-08T1200"     # Git Bash on Windows: use $(pwd -W)
API=http://127.0.0.1:8001

curl -s $API/health
curl -s -X POST $API/fixes -H "Content-Type: application/json" -d "{\"datasetDir\":\"$DS\",\"assetId\":\"S2_PUMP_B\"}"
curl -s -X POST $API/fixes -H "Content-Type: application/json" -d "{\"datasetDir\":\"$DS\",\"assetId\":\"S2_PUMP_B\",\"overrides\":{\"fleetSize\":1}}"
curl -s -X POST $API/fixes/all -H "Content-Type: application/json" -d "{\"datasetDir\":\"$DS\"}"
```

Add `| python -m json.tool` to any line to pretty-print it.

## 5. Things worth trying

| Try | Request |
|---|---|
| Three tanks sharing two trucks | `snapshot_2026-10-08T1200`, assets `S2_PUMP_B`, `S2_PUMP_C`, `S2_PUMP_A` |
| Two trucks on one tank | `snapshot_2026-10-09T0330`, `S4_PUMP_C` |
| A leak | `snapshot_2026-10-08T1200`, `S5_PIPELINE_B` |
| A worn pump | `snapshot_2026-10-08T1200`, `S3_PUMP_A` |
| Time travel | `full_week` with `"asOfUnix": 1791419700` (10-08 00:35, just after EVENT_9 starts), asset `S1_PUMP_C` |
| Repair takes 2 h longer | `"overrides": {"extraRepairHours": 2}` |
| No trucks at all | `"overrides": {"noTrucks": true}` |
| An error | `"assetId": "NOT_A_PUMP"` returns 400 with `{"error": "..."}` |

Times are unix seconds in UTC. `asOfUnix` must be at or before the last reading in the folder.

## 6. Automated tests

```bash
python ml/tests/test_fixes.py          # /fixes: schema, and costs vs the answer keys
python ml/tests/test_fixes.py --show   # same, printing every fix
python ml/tests/test_truncation.py     # /detect uses no future data
python ml/eval/test_original.py        # detector accuracy on the original weeks
```

These read the answer keys to check results. The service itself never does.

## 7. If something fails

| Symptom | Fix |
|---|---|
| Connection refused | The service isn't running: `python ml/serve.py` |
| `/fixes` returns 404 | An old copy of the service is running; stop it and start it again |
| `/fixes` 500 "npx not found" or "planner bridge exited" | Install Node and run `npm install` in the repo root |
| 400 `datasetDir not found` | Use the full absolute path to a folder with the three files |
| 400 `no ongoing event` | That asset has no problem at that time; use `/fixes/all` to list what's ongoing |
| Slow first call (about 2 s) | Normal: it starts the planner and runs the detector, then calls are fast |
| On Windows, `localhost` is slow | Use `127.0.0.1` |
