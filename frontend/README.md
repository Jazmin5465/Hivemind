# Hivemind — Frontend

The night-shift operations console: dashboard, network map and timeline. Built with TanStack Start, React and Tailwind CSS.

All data is **live from the SpacetimeDB backend** (`server/` in this repo) through subscriptions. Nothing is computed from bundled files: alerts, countdowns, plan options and costs, decisions and fleet status come from backend tables. The table reference is `../docs/API.md`, and `../docs/FRONTEND.md` lists what goes where.

- `src/lib/live/store.ts`: one connection. It subscribes to the global tables plus every table of the **active** dataset, and re-subscribes when the active dataset changes (for example the judging flip to `test`).
- `src/lib/live/derive.ts`: pure functions from that snapshot to what the pages render.
- `src/components/LiveProvider.tsx`: `useLive()` for data and `useLiveActions()` for reducer calls (plan options, approve, contingency, send inspector).
- `src/module_bindings/`: generated. Regenerate from the repo root with `npm run server:generate` after any backend change.

## Development

Start the backend first (repo root: `spacetime start`, `npm run setup`, `npm run data:load -- --all data/eog`). Then:

```sh
npm install
cp .env.example .env    # optional: backend address, if it isn't on this machine
npm run dev             # start dev server
npm test                # run vitest
npm run build           # production build
npx tsx scripts/live-smoke.ts [--flow]   # print what the console shows from the running backend
```

For a phone or another laptop on the same network, set `VITE_SPACETIME_URI=ws://<backend-laptop-ip>:3000` in `.env`.
