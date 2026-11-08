// npm run status [-- <datasetId>]  — print what the console shows right now, from the module.
import { connect } from '../stdb';

const want = process.argv[2];
const conn = await connect({
  name: 'status',
  register: false,
  subscribe: ['SELECT * FROM dataset', 'SELECT * FROM sim_clock', 'SELECT * FROM event', 'SELECT * FROM plan', 'SELECT * FROM ml_status'],
});
const datasets = [...conn.db.dataset.iter()];
const ds = want ? datasets.find((d) => d.datasetId === want) : datasets.find((d) => d.active);
if (!ds) {
  console.log(`no ${want ? `dataset ${want}` : 'active dataset'}; loaded: ${datasets.map((d) => d.datasetId).join(', ') || 'none'}`);
  process.exit(1);
}
const clock = [...conn.db.simClock.iter()].find((c) => c.datasetId === ds.datasetId);
const iso = (u?: number) => (u == null ? '-' : new Date(u * 1000).toISOString().slice(5, 16).replace('T', ' '));
const ml = [...conn.db.mlStatus.iter()].find((m) => m.datasetId === ds.datasetId);
console.log(
  `dataset ${ds.datasetId} [${ds.status}${ds.active ? ', ACTIVE' : ''}] ${iso(ds.tStart)} → ${iso(ds.tEnd)} · clock ${iso(clock?.nowUnix)}${clock?.playing ? ' ▶' : ''} · detector ${ds.detector}${ml ? ` · ML ${ml.ok ? ml.modelVersion : 'error: ' + ml.error}` : ''} · recompute ${clock?.computeMs ?? '-'} ms`,
);
const evs = [...conn.db.event.iter()].filter((e) => e.datasetId === ds.datasetId);
const ongoing = evs.filter((e) => e.status === 'ongoing').sort((a, b) => a.alertRank - b.alertRank);
console.log(`events: ${evs.length} total, ${ongoing.length} ongoing`);
const plans = [...conn.db.plan.iter()].filter((p) => p.datasetId === ds.datasetId);
for (const e of ongoing) {
  const p = e.planId != null ? plans.find((x) => x.planId === e.planId) : undefined;
  const h = e.hoursToLimitP50 != null ? ` ${e.hoursToLimitP50.toFixed(2)} h to shutdown (p10 ${e.hoursToLimitP10?.toFixed(2)}, p90 ${e.hoursToLimitP90?.toFixed(2)}) at ${e.levelPct?.toFixed(1)}%` : '';
  console.log(`  #${e.alertRank} ${e.category.padEnd(16)} ${e.assetId.padEnd(16)} since ${iso(e.onsetUnix)} conf ${e.confidence.toFixed(2)} [${e.source}]${h}`);
  if (e.category === 'pump_failure') console.log(`       plan ${p ? `#${p.planId} ${p.status} $${p.totalCost.toFixed(0)} (do nothing $${p.doNothingCost.toFixed(0)}): ${p.summary}` : 'none'}`);
  else console.log('       field inspection');
}
conn.disconnect();
process.exit(0);
