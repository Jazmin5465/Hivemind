# Hivemind

HackUTD "Zero Day". A night-shift console for EOG's **Beat the Shutdown** challenge, built on **SpacetimeDB**, with a **Nemotron** agent.

Hivemind finds pump failures, pipeline leaks and worn pumps in the sensor readings. For every failing pump it counts down to the tank's shutdown. It plans the cheapest response (trucks, early well shut-ins, or let it trip) jointly across a system, because tanks share a truck fleet. The agent explains the plan, runs what-ifs and writes the shift handoff.

```
dataset folder ──► worker (parse CSV) ──► SpacetimeDB module (tables + reducers + scheduled clock)
                                              ▲   │ subscriptions
 Python ML sidecar (ml/) ◄── worker ──────────┘   ▼
 Nemotron (NVIDIA endpoint) ◄── agent worker ◄── events      frontend (frontend/) + operators
```

- **`server/`**: the SpacetimeDB TypeScript module. It owns all state: datasets, the time-travel clock, telemetry, events, plans, claims, handoffs and agent traces. Detection, countdowns and plans are recomputed *inside the module* whenever the clock moves.
- **`core/`**: pure TypeScript logic with no Spacetime imports: tank physics, the exact planner, countdown, rules detector, ML event thresholding, plan validation, number verifier.
- **`worker/`**: the dataset loader, the ML bridge (Hadent's sidecar) and the Nemotron agent.
- **`scripts/`**: data fetch, setup, the test-data flip, and eval (`scripts/eval/` is the only code that reads answer keys).
- **`frontend/`**: the operator console (TanStack Start + React), live from SpacetimeDB subscriptions.
- **`docs/API.md`**: the tables and reducers the frontend uses. **`docs/ML_CONTRACT.md`**: the sidecar contract.

All data comes from the three files of a dataset folder (`network.json`, `ops.json`, `telemetry.csv`). "Now" is the last `ts_unix` in the telemetry. No IDs, counts or thresholds are hardcoded.

## Run it (macOS)

```bash
curl -sSf https://install.spacetimedb.com | sh     # SpacetimeDB CLI (2.14.x)
npm install
spacetime start                                     # local server on :3000 (separate terminal)
npm run setup                                       # publish module, set worker key, generate bindings
npm run data:fetch                                  # EOG datasets -> data/eog (gitignored)
npm run data:load -- --all data/eog                 # load every folder (~1.5 s total)
npm run status                                      # what the console shows right now
npm run worker                                      # optional: ML bridge (needs the sidecar: npm run ml)
npm run agent                                       # optional: Nemotron agent (LLM settings in .env)
```

Copy `.env.example` to `.env`; `npm run setup` does this for you. Secrets live only in `.env`, which is gitignored.

## The judging flip

```bash
npm run flip                       # fetch EOG test/ -> data/test, load as dataset "test", activate, print alerts
npm run flip -- --local            # test files dropped into data/test by hand
npm run flip:drill                 # rehearsal with history/mock_test_*
```

## Checks

```bash
npm test                 # unit tests + full eval in strict mode
npm run eval             # one-screen scoreboard vs the answer keys (detection, countdowns, alert order, plan costs)
npm run eval:ml          # the same detection scoring for the ML sidecar path
npm run check:answer-key # answer_key never referenced by app code
npm run export:events -- data/eog/snapshot_2026-10-10T0900   # events.json in the SPEC shape
```

See `STATUS.md` for current results and open questions.
