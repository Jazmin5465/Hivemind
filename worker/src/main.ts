// npm run worker — long-running backend worker:
//  * ML bridge: whenever a dataset is (re)loaded, run the sidecar's /detect and store the
//    probabilities; retry when the sidecar comes back. The module falls back to rules otherwise.
//  * Evidence: SHAP drivers from /explain for ongoing events of the active dataset.
//  * Fixes: costed fixes (cost reasoning + predicted sequence) from /fixes/all for the active
//    dataset at the backend clock, stored in fix_option for the decision popup.
// The Nemotron agent runs as its own process (npm run agent) so one can't stall the other.
import { connect, env } from './stdb';
import { fixesToRows, mlExplain, mlFixesAll, mlHealth, syncMl } from './ml';

const log = (s: string) => console.log(`[worker ${new Date().toISOString().slice(11, 19)}] ${s}`);
const ML_ENABLED = env('ML_ENABLED', 'true') !== 'false';
const HEALTH_EVERY_MS = 15_000;

const conn = await connect({
  name: 'worker',
  subscribe: [
    'SELECT * FROM dataset',
    'SELECT * FROM sim_clock',
    'SELECT * FROM event',
    'SELECT * FROM event_evidence',
    'SELECT * FROM ml_status',
  ],
});
log(`connected; ML ${ML_ENABLED ? `enabled at ${env('ML_URL', 'http://127.0.0.1:8001')}` : 'disabled'}`);

const syncedVersion = new Map<string, number>(); // datasetId -> loadVersion synced OK
const inFlight = new Set<string>();
const explained = new Set<string>();
let fixesKey = ''; // `${datasetId}@${loadVersion}@${nowUnix}@${ongoing ids}` last stored
let fixesAt = 0;
let fixesBusy = false;
const FIXES_MIN_GAP_PLAYING_MS = 15_000;

/** /fixes/all for the active dataset at the backend clock -> fix_option (skips if nothing changed). */
async function syncFixes() {
  if (!ML_ENABLED || !mlUp || fixesBusy) return;
  const active = [...conn.db.dataset.iter()].find((d) => d.active && d.status === 'ready');
  if (!active) return;
  const clock = conn.db.simClock.datasetId.find(active.datasetId);
  if (!clock) return;
  const events = [...conn.db.event.iter()].filter((e) => e.datasetId === active.datasetId);
  const ongoing = events.filter((e) => e.status === 'ongoing').map((e) => e.eventId).sort().join(',');
  const key = `${active.datasetId}@${active.loadVersion}@${clock.nowUnix}@${ongoing}`;
  if (key === fixesKey) return;
  if (clock.playing && Date.now() - fixesAt < FIXES_MIN_GAP_PLAYING_MS) return;
  fixesBusy = true;
  const t0 = Date.now();
  try {
    const resp = await mlFixesAll(active.source, clock.nowUnix);
    const rows = fixesToRows(resp, active.datasetId, events);
    await conn.reducers.mlPutFixes({ datasetId: active.datasetId, asOfUnix: clock.nowUnix, fixes: rows });
    fixesKey = key;
    fixesAt = Date.now();
    log(`fixes ${active.datasetId} @ ${new Date(clock.nowUnix * 1000).toISOString().slice(5, 16)}: ${rows.length} fixes for ${new Set(rows.map((r) => r.eventId)).size} events (${Date.now() - t0} ms)`);
  } catch (err) {
    // e.g. no ongoing problem / sidecar down: clear so the popup never shows stale reasoning
    fixesKey = key;
    await conn.reducers.mlPutFixes({ datasetId: active.datasetId, asOfUnix: clock.nowUnix, fixes: [] }).catch(() => {});
    log(`fixes unavailable for ${active.datasetId}: ${(err as Error).message}`);
  } finally {
    fixesBusy = false;
  }
}
let mlUp = false;

async function maybeSync(datasetId: string) {
  if (!ML_ENABLED || !mlUp || inFlight.has(datasetId)) return;
  const ds = conn.db.dataset.datasetId.find(datasetId);
  if (!ds || ds.status !== 'ready') return;
  if (syncedVersion.get(datasetId) === ds.loadVersion) return;
  inFlight.add(datasetId);
  try {
    const ok = await syncMl(conn, ds, log);
    if (ok) syncedVersion.set(datasetId, ds.loadVersion);
  } finally {
    inFlight.delete(datasetId);
  }
}

async function syncAll() {
  // active dataset first, so the live console gets ML soonest
  const all = [...conn.db.dataset.iter()].sort((a, b) => Number(b.active) - Number(a.active));
  for (const d of all) await maybeSync(d.datasetId);
}

async function explainOngoing() {
  if (!ML_ENABLED || !mlUp) return;
  const active = [...conn.db.dataset.iter()].find((d) => d.active && d.status === 'ready');
  if (!active) return;
  const ml = conn.db.mlStatus.datasetId.find(active.datasetId);
  if (!ml?.ok) return;
  const clock = conn.db.simClock.datasetId.find(active.datasetId);
  if (!clock || clock.playing) return;
  const evidence = [...conn.db.eventEvidence.iter()];
  for (const e of conn.db.event.iter()) {
    if (e.datasetId !== active.datasetId || e.status !== 'ongoing' || e.source === 'injected') continue;
    const key = `${e.eventId}@${active.loadVersion}`;
    if (explained.has(key) || evidence.some((r) => r.eventId === e.eventId && r.source === 'shap')) continue;
    explained.add(key);
    try {
      const { drivers } = await mlExplain(active.source, e.assetId, e.category, e.onsetUnix, clock.nowUnix);
      if (drivers?.length) await conn.reducers.mlPutEvidence({ eventId: e.eventId, drivers: drivers.slice(0, 3) });
      log(`explained ${e.eventId}: ${drivers?.length ?? 0} drivers`);
    } catch (err) {
      log(`explain failed for ${e.eventId}: ${(err as Error).message}`);
    }
  }
}

async function heartbeat() {
  if (!ML_ENABLED) return;
  const h = await mlHealth();
  if (h.ok !== mlUp) log(h.ok ? `ML sidecar up (${h.modelVersion})` : `ML sidecar down: ${h.error}`);
  mlUp = h.ok;
  if (mlUp) {
    await syncAll();
    await explainOngoing();
    await syncFixes();
  }
}

conn.db.dataset.onInsert((_ctx, d) => void maybeSync(d.datasetId));
conn.db.dataset.onUpdate((_ctx, _old, d) => void maybeSync(d.datasetId));
let explainTimer: NodeJS.Timeout | null = null;
const scheduleExplain = () => {
  if (explainTimer) clearTimeout(explainTimer);
  explainTimer = setTimeout(() => void explainOngoing(), 1500);
};
let fixesTimer: NodeJS.Timeout | null = null;
const scheduleFixes = () => {
  if (fixesTimer) clearTimeout(fixesTimer);
  fixesTimer = setTimeout(() => void syncFixes().catch((e) => log(`fixes error: ${(e as Error).message}`)), 1500);
};
conn.db.event.onInsert(() => (scheduleExplain(), scheduleFixes()));
conn.db.event.onDelete(() => scheduleFixes());
conn.db.simClock.onUpdate(() => (scheduleExplain(), scheduleFixes()));
conn.db.dataset.onUpdate(() => scheduleFixes());

await heartbeat();
setInterval(() => void heartbeat().catch((e) => log(`heartbeat error: ${(e as Error).message}`)), HEALTH_EVERY_MS);
process.on('SIGINT', () => {
  conn.disconnect();
  process.exit(0);
});
