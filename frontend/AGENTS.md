
## Operational data (live backend)
- All operational data comes from the SpacetimeDB backend through subscriptions (`src/lib/live/store.ts`). Never bundle dataset files (network, ops, telemetry) into the app, and never import answer keys.
- Show the backend's numbers as they arrive: alerts and their order (`event.alertRank`), countdowns, plan options and costs. Don't recompute detection or plan costs in the browser. Display-only derivations live in `src/lib/live/derive.ts` as pure, tested functions.
- "Now" is the backend clock (`sim_clock.nowUnix`), never the browser clock. Show only the active dataset (`dataset.active`).
- Never hardcode systems, facilities, coordinates or limits. Take them from the backend tables, because the judging network (S6–S11) differs from the practice one.

## Operator decisions
- Decisions are shared backend rows (`decision` table), not browser storage. Plan options come from the reducer `requestPlanOptions`. Submitting calls `approvePlan`, `selectContingency` (hypothetical "pump fails now" items) or `sendInspector` (leaks and worn pumps).
- Plans are per system (shared trucks): one approval can cover several failures.
- Relationship edges connect explicit IDs (incident to recovery, item to decision), never adjacent timestamps; chronological proximity alone is not evidence of causality.
- Prebundle dialog and radio-group dependencies at Vite startup; late dependency discovery can invalidate React's module graph while a popup is mounting.
