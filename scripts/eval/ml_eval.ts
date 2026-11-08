// npm run eval:ml — score the ML path (sidecar probabilities -> core/mlEvents thresholding,
// merged with rules pump failures exactly as the module does) against the answer keys.
// Needs the sidecar running at ML_URL. Eval-only (reads answer keys).
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadFolder } from '../../worker/src/folder';
import { mlDetect, mlHealth, probsToChunks } from '../../worker/src/ml';
import { analyze } from '../../core/src/analyze';
import { detectRules } from '../../core/src/detector/rules';
import { tEnd, seriesKey } from '../../core/src/telemetry';
import { readAnswerKey } from './answerKey';
import { scoreDetection } from './detection';

const root = resolve(process.argv[2] ?? 'data/eog');
const h = await mlHealth();
if (!h.ok) {
  console.log(`ML sidecar not reachable (${h.error}); start ml/serve.py first`);
  process.exit(1);
}
console.log(`ML eval · model ${h.modelVersion} · ${root}`);
const fmtH = (s: number | null) => (s == null ? '-' : `${(s / 3600).toFixed(2)}h`);
for (const name of readdirSync(root).sort()) {
  const dir = join(root, name);
  if (!existsSync(join(dir, 'telemetry.csv'))) continue;
  const labels = readAnswerKey(dir);
  const d = loadFolder(dir);
  const g = d.grid;
  const resp = await mlDetect(d.dir, tEnd(g));
  for (const c of probsToChunks(resp, { tStart: g.t0, stepSec: g.stepSec, nSteps: g.n })) {
    const k = seriesKey(c.assetId, c.metric);
    let a = g.series.get(k);
    if (!a) g.series.set(k, (a = new Float64Array(g.n).fill(NaN)));
    const off = Math.round((c.t0 - g.t0) / g.stepSec);
    c.values.forEach((v, i) => (a![off + i] = v));
  }
  const viaMl = (asOfUnix: number) => analyze({ model: d.model, grid: g, asOfUnix, detector: 'ml', skipPlans: true }).events;
  if (!labels) {
    const evs = viaMl(tEnd(g));
    const rules = detectRules(d.model, g, {});
    console.log(`  ${name}: ${evs.length} events via ML (rules: ${rules.length}); ongoing: ${evs.filter((e) => e.status === 'ongoing').map((e) => `${e.category}:${e.assetId}`).join(', ') || 'none'}`);
    continue;
  }
  for (const [tag, detect] of [['ml   ', viaMl], ['rules', (asOfUnix: number) => detectRules(d.model, g, { asOfUnix })]] as const) {
    const s = scoreDetection(d.model, g, labels, { tolSec: 3600, sweepStepSec: 1800, detect });
    if (!s.ok) {
      console.log(`  ${name} ${tag}: error ${s.error}`);
      continue;
    }
    const v = s.value;
    const cats = Object.entries(v.perCategory).map(([c, x]) => `${c.replace('pump_', '').replace('pipeline_', '')} ${x.hits}/${x.total}`).join('  ');
    console.log(
      `  ${name.padEnd(28)} ${tag} ${cats} │ FA ${v.matching.falseAlarms.length} │ ongoing ${v.ongoing.hits}/${v.ongoing.total} │ first-seen med ${fmtH(v.latencyMedianSec)} max ${fmtH(v.latencyMaxSec)}`,
    );
  }
}
