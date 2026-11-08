# Eval harness

Scores the detector, countdown, alert order and planner against `answer_key.json` in each dataset folder.
**`scripts/eval/` is the only place allowed to read `answer_key.json`.** Nothing outside it may import `answerKey.ts`
(`npm run check:answer-key` greps app code).

```
npm run eval                                   # default data root: <repo>/data/eog (every subfolder with the 3 dataset files)
npm run eval -- --data /path/to/eog --verbose  # per-label detail, false alarms, plan summaries, failed checks
npm run eval -- --json out.json --strict       # machine-readable report; exit 1 if any check fails (CI)
npm run eval -- --only snapshot --busy ref     # filter folders; replay with reference-plan truck busy times
```

Core functions that are still stubs show `N/A (not implemented)`. N/A checks do not fail `--strict`.

## What it checks

| Section | Folders | Check |
|---|---|---|
| `detect` | labelled | Each label matched to a detected event with the same category and `assetId`, detected onset in `[onset − tol, end or now]` (`--tol-min`, default 60). Per category hits/total, false alarms, duplicates, onset delta. Snapshots: each `ongoing` label is detected as ongoing. Fully resolved folders (full_week): sweeps `asOfUnix` every `--sweep-min` (30) for first-detected latency |
| `oracle:countdown` / `oracle:alerts` | snapshots | For each ongoing pump failure: `countdownAt` level vs `level_final_pct` (±1.0), `hoursToLimitP50` vs `hours_to_limit_final` (±0.1 h), and `orderAlerts` position vs `order`. Failures come from the label onsets, so this scores countdown/planner without the detector |
| `oracle:plan` | snapshots | `planSystem` per system from "now" (level from countdown, falling back to telemetry; repair end = onset + repair hours). Pass if our system total ≤ the sum of reference costs + $1. Cheaper totals are flagged "better than reference?" for manual review |
| `detected:*` | snapshots | The same checks with failures from `detectRules` at "now" |
| `plan` | fully resolved | Replays pump failures in onset order, each planned alone at its onset with trucks still busy on earlier plans in the same system (`busyTruckFreeAtUnix`). Cost vs reference, and free trucks vs the "(k of N trucks free)" note |
| `sanity` | fully resolved | The first single-truck/single-trip reference event: do-nothing, no-trucks (`fleetSize: 0` override) and planned cost |
| `model` | snapshots | `lost_revenue_per_hour` in the key equals the facility's revenue/h from the model |

Unlabelled folders (mock test, `test/`) only list what the detector finds.

Files: `answerKey.ts` (reader and `reference_action` parser), `detection.ts`, `snapshot.ts`, `replay.ts`, `run.ts`.
Tests: `answerKey.test.ts` (parser), `run.test.ts` (scoreboard smoke test with fake core functions; skipped without data).
