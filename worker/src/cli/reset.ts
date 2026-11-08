// Reset datasets in the running app back to a fresh state. Pure Node: no bash and no
// spacetime CLI needed, so it runs the same from PowerShell, Git Bash or a Mac terminal.
//
//   npm run data:reset                                  the active dataset (what the UI shows)
//   npm run data:reset -- snapshot_2026-10-08T1200      these dataset ids
//   npm run data:reset -- --all                         every loaded dataset with a folder
//   npm run data:reset -- --clock-only                  only restart the clock (fresh countdowns)
//
// Full reset (default): reloads the dataset from its folder. That deletes its events, plans,
// approved decisions, what-ifs, injected demo failures, fleet sweeps and fix options, rebuilds
// everything from the files, and sets the clock back to the recording's "now", so countdowns
// start fresh. The active dataset does not change. Operator names, claims, handoffs and agent
// history are kept (the backend keeps them on purpose). Then it waits for the worker to put
// the ML results back, and says so if it doesn't.
//
// Connects like the other worker tools (its own token in data/, WORKER_KEY from .env).
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { connect, env, REPO_ROOT } from '../stdb';
import { uploadFolder } from '../load';

const args = process.argv.slice(2);
const clockOnly = args.includes('--clock-only');
const all = args.includes('--all');
const named = args.filter((a) => !a.startsWith('--'));

function folderFor(id: string): string | null {
  const c = [join(REPO_ROOT, 'data', 'eog', id), join(REPO_ROOT, 'data', id)];
  if (id === 'test') c.push(join(REPO_ROOT, 'data', 'test'));
  return c.find((d) => existsSync(join(d, 'telemetry.csv'))) ?? null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const conn = await connect({ name: 'reset', subscribe: ['SELECT * FROM dataset'] });
const datasets = [...conn.db.dataset.iter()];
let ids: string[];
if (all) ids = datasets.map((d) => d.datasetId).sort();
else if (named.length) ids = named;
else {
  const active = datasets.find((d) => d.active);
  if (!active) {
    console.error('no active dataset; pass a dataset id');
    process.exit(1);
  }
  ids = [active.datasetId];
}

let failed = 0;
const reloaded: string[] = [];
for (const id of ids) {
  if (clockOnly) {
    try {
      await conn.reducers.resetClock({ datasetId: id });
      console.log(`✓ ${id}: clock reset to the recording's now (countdowns restarted)`);
    } catch (e) {
      failed++;
      console.error(`✗ ${id}: ${(e as Error).message}`);
    }
    continue;
  }
  const folder = folderFor(id);
  if (!folder) {
    failed++;
    console.error(`✗ ${id}: no folder found (looked in data/eog/${id}, data/${id}${id === 'test' ? ', data/test' : ''})`);
    continue;
  }
  try {
    await uploadFolder(conn, folder, { datasetId: id, activate: false, log: () => {} });
    reloaded.push(id);
    console.log(`✓ ${id}: reloaded fresh (events, plans and decisions rebuilt; clock at the recording's now)`);
  } catch (e) {
    failed++;
    console.error(`✗ ${id}: ${(e as Error).message}`);
  }
}

// After a reload the ML results are gone until the worker re-sends them.
if (reloaded.length) {
  const mlUrl = env('ML_URL', 'http://127.0.0.1:8001');
  let mlUp = false;
  try {
    mlUp = (await fetch(`${mlUrl}/health`, { signal: AbortSignal.timeout(3000) })).ok;
  } catch {
    mlUp = false;
  }
  if (!mlUp) {
    console.log(`ML sidecar is not running (${mlUrl}), so the console uses the rules detector. Start it with: npm run ml`);
  } else {
    const deadline = Date.now() + 25_000;
    const pending = new Set(reloaded);
    while (pending.size && Date.now() < deadline) {
      await sleep(1000);
      for (const id of [...pending]) if (conn.db.dataset.datasetId.find(id)?.detector === 'ml') pending.delete(id);
    }
    for (const id of reloaded) {
      if (!pending.has(id)) console.log(`✓ ${id}: ML detector back on`);
      else {
        console.error(`! ${id}: still on the rules detector after 25 s. The worker is not responding;`);
        console.error('  restart it (close its window, then: npm run worker) and it will re-send the ML results.');
      }
    }
  }
}

// Let in-flight network messages settle, then exit without closing the socket ourselves: on
// Windows, exiting while they are pending trips a libuv assertion ("UV_HANDLE_CLOSING") that
// looks like a crash. The OS closes the socket.
await sleep(500);
process.exit(failed ? 1 : 0);
