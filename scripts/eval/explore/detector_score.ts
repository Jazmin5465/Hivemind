// Score the rules detector against answer keys (eval-only: this is the one place that reads them).
// Usage: npx tsx scripts/eval/explore/detector_score.ts [dataRoot]
//   dataRoot defaults to /Users/suhan/HackUTD26/Hivemind/data/eog
// For each labelled folder: per-event hit / onset error / end error / detection latency,
// plus false alarms. For unlabelled folders (mock test): just lists detections.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadFolder } from '../../../worker/src/folder';
import { detectRules } from '../../../core/src/detector/rules';
import { tsAt } from '../../../core/src/telemetry';
import type { DetectedEvent } from '../../../core/src/types';

const root = process.argv[2] ?? '/Users/suhan/HackUTD26/Hivemind/data/eog';

interface Label {
  id: string;
  category: string;
  asset: string;
  onset_unix: number;
  end_unix: number | null;
  status: string;
}

const iso = (u: number | null) => (u == null ? '-' : new Date(u * 1000).toISOString().slice(5, 16));
const hrs = (s: number) => `${s >= 0 ? '+' : ''}${(s / 3600).toFixed(2)}h`;

function overlaps(d: DetectedEvent, l: Label, asOf: number) {
  if (d.category !== l.category || d.assetId !== l.asset) return false;
  const dEnd = d.endUnix ?? asOf + 1;
  const lEnd = l.end_unix ?? asOf + 1;
  // allow detected onset up to 3 h after the labelled end (leaks seen only once pumping resumes)
  return d.onsetUnix < lEnd + 3 * 3600 && dEnd > l.onset_unix;
}

let totalMiss = 0;
let totalFA = 0;
for (const name of readdirSync(root).sort()) {
  const dir = join(root, name);
  if (!existsSync(join(dir, 'telemetry.csv'))) continue;
  const { model, grid } = loadFolder(dir);
  const asOf = tsAt(grid, grid.n - 1);
  const t0 = performance.now();
  const dets = detectRules(model, grid);
  const ms = performance.now() - t0;
  console.log(`\n=== ${name}  now=${iso(asOf)}  detections=${dets.length}  (${ms.toFixed(0)} ms)`);
  const keyPath = join(dir, 'answer_key.json');
  if (!existsSync(keyPath)) {
    for (const d of dets)
      console.log(`  ${d.category.padEnd(16)} ${d.assetId.padEnd(14)} onset=${iso(d.onsetUnix)} end=${iso(d.endUnix)} ${d.status.padEnd(8)} conf=${d.confidence}  | ${d.evidence[0]}`);
    continue;
  }
  const labels = JSON.parse(readFileSync(keyPath, 'utf8')) as Label[];
  const used = new Set<DetectedEvent>();
  for (const l of labels) {
    const m = dets.filter((d) => !used.has(d) && overlaps(d, l, asOf));
    m.forEach((d) => used.add(d));
    const d = m[0];
    let line = `  ${l.id.padEnd(9)} ${l.category.padEnd(16)} ${l.asset.padEnd(14)} ${iso(l.onset_unix)}..${iso(l.end_unix)} ${l.status.padEnd(8)}`;
    if (!d) {
      totalMiss++;
      line += '  MISS';
    } else {
      // latency: earliest asOf (5-min steps) at which an overlapping event is reported
      let lat = NaN;
      for (let t = Math.max(grid.t0, l.onset_unix); t <= asOf; t += grid.stepSec) {
        if (detectRules(model, grid, { asOfUnix: t }).some((x) => overlaps(x, l, t))) {
          lat = t - l.onset_unix;
          break;
        }
      }
      const statusOk = d.status === l.status ? '' : ` STATUS(${d.status})`;
      line += `  HIT onsetErr=${hrs(d.onsetUnix - l.onset_unix)} endErr=${d.endUnix != null && l.end_unix != null ? hrs(d.endUnix - l.end_unix) : iso(d.endUnix)} latency=${hrs(lat)} conf=${d.confidence}${statusOk}`;
      if (m.length > 1) line += ` SPLIT x${m.length}`;
      if (statusOk) totalMiss += l.status === 'ongoing' ? 1 : 0;
    }
    console.log(line);
  }
  const fas = dets.filter((d) => !used.has(d));
  totalFA += fas.length;
  for (const d of fas)
    console.log(`  FALSE ALARM ${d.category} ${d.assetId} onset=${iso(d.onsetUnix)} end=${iso(d.endUnix)} conf=${d.confidence} | ${d.evidence.join(' | ')}`);
}
console.log(`\nTOTAL misses=${totalMiss} falseAlarms=${totalFA}`);
