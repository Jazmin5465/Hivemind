# Hivemind — Frontend

Night-shift operations console (dashboard, network map, timeline) built with TanStack Start, React, and Tailwind CSS.

This folder contains only the frontend. The backend lives on a separate branch and will be integrated later. Until then:

- Operator decisions are saved in browser `localStorage` (`src/lib/browser-decisions.ts`).
- Network, ops, and telemetry data are bundled as static JSON in `src/data/`.

## Development

```sh
npm install
npm run dev     # start dev server
npm test        # run vitest
npm run build   # production build
```
