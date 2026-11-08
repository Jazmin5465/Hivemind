// Bias of our planning-level estimate vs labelled levels (onset levels in full_week, final levels in snapshots). Eval-only.
import { readdirSync, existsSync } from 'node:fs';
import { loadFolder } from '../../../worker/src/folder';
import { readAnswerKey } from '../answerKey';
import { countdownAt } from '../../../core/src/countdown';
import { tEnd } from '../../../core/src/telemetry';
const errs: number[] = [];
for (const name of readdirSync('data/eog').sort()) {
  const dir = `data/eog/${name}`;
  if (!existsSync(`${dir}/answer_key.json`)) continue;
  const d = loadFolder(dir);
  for (const e of readAnswerKey(dir)!) {
    if (e.category !== 'pump_failure') continue;
    if (name === 'full_week' && e.levelPct != null) {
      const cd = countdownAt(d.model, d.grid, e.facility, e.onsetUnix, { sinceUnix: e.onsetUnix });
      errs.push(cd.levelPct - e.levelPct);
      console.log(name, e.id, 'onset', e.levelPct, cd.levelPct.toFixed(3), 'raw', cd.levelPctRaw, (cd.levelPct - e.levelPct).toFixed(3));
    }
    if (e.levelFinalPct != null) {
      const cd = countdownAt(d.model, d.grid, e.facility, tEnd(d.grid), { sinceUnix: e.onsetUnix });
      // label is rounded to 0.1, so compare against the noiseless line from the onset level instead
      const f = d.model.facilityById.get(e.facility)!;
      const truth = e.levelPct! + (f.baselineInflowBpd / 24 / f.capacityBbl) * 100 * (tEnd(d.grid) - e.onsetUnix) / 3600;
      console.log(name, e.id, 'final', e.levelFinalPct, 'line-from-onset', truth.toFixed(3), 'ours', cd.levelPct.toFixed(3), (cd.levelPct - truth).toFixed(3));
    }
  }
}
const m = errs.reduce((a, b) => a + b, 0) / errs.length;
console.log('onset errors: mean', m.toFixed(4), 'sd', Math.sqrt(errs.reduce((a, b) => a + (b - m) ** 2, 0) / (errs.length - 1)).toFixed(4));
