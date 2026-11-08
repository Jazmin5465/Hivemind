# Hivemind agent (Nemotron, worker process)

The agent runs as a worker process: `npm run agent`. It watches the module's tables and acts on its own whenever a new problem shows up. Nobody has to type anything. Every number it computes comes from `core/`: the exact planner, the tank simulator, plan validation, and the countdown. The LLM picks which tools to run and writes the text. Before anyone sees that text, every number in it is checked against the tool results.

## Loop (one `agent_run` per trigger)

| Trigger | What runs |
|---|---|
| New ongoing **pump failure** (debounced 3 s per system, so failures arriving together are planned together) | 1. **Diagnose:** `get_event_context` for each failure, then `get_system_state`.<br>2. **Plan:** `plan_system`, the exact joint plan for the whole system.<br>3. **What-ifs:** `plan_system` with one truck fewer, and with the repair 2 h longer, plus `compare_plans`. If the LLM is on, it can request up to 3 more rounds of tool calls (`plan_system` / `simulate_tank` / `compare_plans`).<br>4. **Critic:** `validate_plan` checks the fleet limit (trucks already busy on approved plans count), that every trip arrives before the repair ends, tank volume, and that every failure is covered. If the plan is invalid, it re-plans once.<br>5. **`propose_plan`:** if the plan matches the module's planner plan action for action, it calls `agent_endorse_plan` (attaches the rationale and run id). Otherwise `agent_propose_plan`, which the module validates again.<br>6. **Texts:** an operator summary goes into `agent_run.summary`, and messages for the truck crew / field crew go into `dispatch_message`. |
| New ongoing **leak or worn pump** | `get_event_context`, then a summary and a field-inspector dispatch. No trucks. |
| `agent_question` with status `pending` (from `ask_agent`) | Natural language becomes planner calls. With the LLM on, it chooses the `plan_system` overrides itself. In template mode, `parseQuestion` maps phrases like "lose a truck", "only have one truck", "no trucks", "repair 2 hours longer", "repair takes 8 h", or "keep S2_WELL_A1 on" to overrides. The answer is written with `agent_answer`. A handoff question also posts a handoff. |
| `npm run agent -- --handoff` | `draft_handoff`, then a 30-second plain-English note via `agent_post_handoff`. |

While the clock is **playing**, each system or event runs at most once per 30 s. A restarted agent skips events that already have a run. Use `--catch-up` or `--once` to redo them.

## Guardrail: the number verifier (`core/src/verifier.ts`)

`extractClaims` pulls every number out of the text: dollar figures (`$1,234`, `$3.1k`), clock times (`HH:MM`, read as UTC), durations (`+46 min`, `1.4 h`, `1 h 35 min`), percentages, volumes (bbl), and counts (`2 trucks`, `one trip`, `three wells`). Digits inside IDs like `S2_WELL_C1` are ignored.

Each claim must match a fact from that run's tool results. Facts are collected from tool results by key name, plus numbers quoted inside tool strings such as detector evidence and planner summaries. Tolerances:

| Kind | Tolerance |
|---|---|
| Dollars | $1 or 0.5% |
| Hours | 0.05 h |
| Minutes | 1 |
| Percent | 0.15 |
| Counts | exact |
| Clock times | 1 min |

Rounding to the precision as written is also accepted ("1.4 h" for 1.42).

If the LLM's text fails, the runner asks it to rewrite and names the unsupported numbers. It retries at most twice, then falls back to a **template** built only from tool output (`worker/src/agent/templates.ts`). The verifier also re-checks the template, and its result is logged.

## Trace (`agent_step`)

| `kind` | Meaning |
|---|---|
| `tool` | one tool call: `toolName`, `argsJson`, `resultSummary` (truncated JSON), `latencyMs`, `ok` |
| `llm` | one chat round: tool calls requested or text drafted; `ok=false` on an LLM error |
| `critic` | `validate_plan` result (valid, or the list of violations) |
| `verifier` | `number_check` for each draft: `ok`, or the unsupported numbers |
| `fallback` | the template was used (why, and whether its numbers verified), or a run error |

`agent_run` has `status` (`running` / `done` / `failed`), `provider`, `model`, `latencyMs`, `planId` (the endorsed or proposed plan) and `summary`.

## Configuration (`.env`)

| Var | Meaning |
|---|---|
| `LLM_PROVIDER` | `template` (default; no network), `nvidia_hosted`, or `brev` (Hadent's vLLM) |
| `LLM_BASE_URL` | `https://integrate.api.nvidia.com/v1` for hosted; `http://<host>:8000/v1` for Brev |
| `LLM_MODEL` | hosted default `nvidia/nemotron-nano-3-30b-a3b`. Note: `nvidia/nemotron-3-nano-30b-a3b` now returns **410 end-of-life**. On Brev: `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-FP8` (per Hadent) |
| `LLM_API_KEY` | bearer key. For `nvidia_hosted`, `NVIDIA_API_KEY` is used if this is empty |
| `LLM_TEMPERATURE`, `LLM_TOP_P` | defaults 1.0 / 0.95 (NVIDIA's recommendation); lower them if tool calls are flaky |
| `LLM_ENABLE_THINKING` | sent as `chat_template_kwargs.enable_thinking` (default false); `<think>` blocks are stripped |
| `LLM_TIMEOUT_MS`, `LLM_MAX_TOKENS` | defaults 12000 / 700 |
| `AGENT_DEBOUNCE_MS` | default 3000 |

## Resilience

If the LLM times out, returns an HTTP error (429 included), returns a malformed reply, or uses bad tool arguments, the run falls back to templates. After 3 failures in a row, the client skips the network for 60 s. Each run is isolated, so one bad event or dataset never stops the loop.

## Run

```
npm run agent                 # watch and act (Ctrl-C to stop)
npm run agent -- --once       # act on every ongoing event of the active dataset, then exit
npm run agent -- --handoff    # post a shift handoff and exit
npm run agent -- --probe      # GET /models + a 1-token chat, then exit
```

The worker reads each dataset's three files from `dataset.source`, the folder path the loader used, so it must run on the same machine as the loader.

## Tests

`core/test/verifier.test.ts` and `core/test/agent.test.ts` cover a fake backend in template mode: the pump-failure run end to end, an inspection, questions turning into planner calls, the handoff, the fallback when the LLM is down, scheduler debouncing, and question parsing.
