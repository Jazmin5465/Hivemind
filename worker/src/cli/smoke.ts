// npm run smoke — consistency check: for every loaded dataset, the module's events and planner
// totals (at its clock) must equal core/analyze run directly on the dataset folder.
// Datasets on the ML path are compared by fetching the same probabilities from the sidecar.
import { connect } from '../stdb';
import { loadFolder } from '../folder';
import { analyze, eventKey } from '../../../core/src/analyze';
import { seriesKey } from '../../../core/src/telemetry';
import { mlDetect, probsToChunks } from '../ml';

const conn = await connect({
  name: 'smoke',
  register: false,
  subscribe: ['SELECT * FROM dataset', 'SELECT * FROM sim_clock', 'SELECT * FROM event', 'SELECT * FROM plan', 'SELECT * FROM injected_failure'],
});
let bad = 0;
for (const ds of conn.db.dataset.iter()) {
  if (ds.status !== 'ready') continue;
  const clock = conn.db.simClock.datasetId.find(ds.datasetId);
  if (!clock) continue;
  const t0 = Date.now();
  const d = loadFolder(ds.source, ds.datasetId);
  let mlVersion: string | undefined;
  if (ds.detector === 'ml') {
    try {
      const resp = await mlDetect(d.dir, ds.tEnd);
      mlVersion = resp.modelVersion;
      const g = d.grid;
      for (const c of probsToChunks(resp, { tStart: g.t0, stepSec: g.stepSec, nSteps: g.n })) {
        const k = seriesKey(c.assetId, c.metric);
        let a = g.series.get(k);
        if (!a) g.series.set(k, (a = new Float64Array(g.n).fill(NaN)));
        const off = Math.round((c.t0 - g.t0) / g.stepSec);
        c.values.forEach((v, i) => (a![off + i] = v));
      }
    } catch (e) {
      console.log(`- ${ds.datasetId}: detector=ml but sidecar unreachable (${(e as Error).message}); skipped`);
      continue;
    }
  }
  const injected = [...conn.db.injectedFailure.iter()].filter((r) => r.datasetId === ds.datasetId).map((r) => ({ facilityId: r.facilityId, onsetUnix: r.onsetUnix, levelPct: r.levelPct }));
  const committed = [...conn.db.plan.iter()].filter((p) => p.datasetId === ds.datasetId && p.status === 'approved');
  const out = analyze({ model: d.model, grid: d.grid, asOfUnix: clock.nowUnix, injected, mlModelVersion: mlVersion });
  const mine = new Set(out.events.map((e) => `${ds.datasetId}:${eventKey(e)}`));
  const theirs = new Set([...conn.db.event.iter()].filter((e) => e.datasetId === ds.datasetId).map((e) => e.eventId));
  const missing = [...mine].filter((x) => !theirs.has(x));
  const extra = [...theirs].filter((x) => !mine.has(x));
  const plannerPlans = [...conn.db.plan.iter()].filter((p) => p.datasetId === ds.datasetId && p.origin === 'planner' && p.status === 'proposed');
  const modTotal = plannerPlans.reduce((a, p) => a + p.totalCost, 0);
  const coreTotal = committed.length ? NaN : out.plans.reduce((a, p) => a + p.totalCost, 0);
  const planOk = committed.length ? true : Math.abs(modTotal - coreTotal) < 0.01;
  const ok = !missing.length && !extra.length && planOk;
  if (!ok) bad++;
  console.log(
    `${ok ? '✓' : '✗'} ${ds.datasetId} [${ds.detector}] @ ${new Date(clock.nowUnix * 1000).toISOString().slice(5, 16)}: events ${theirs.size} (core ${mine.size}) · planner $${modTotal.toFixed(0)}${committed.length ? ' (approved plans present; total not compared)' : ` (core $${coreTotal.toFixed(0)})`} · ${Date.now() - t0} ms`,
  );
  for (const m of missing) console.log(`    missing in module: ${m}`);
  for (const x of extra) console.log(`    extra in module: ${x}`);
}
conn.disconnect();
process.exit(bad ? 1 : 0);
