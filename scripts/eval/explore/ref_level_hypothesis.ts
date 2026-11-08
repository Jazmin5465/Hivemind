// Which level does the reference plan from at "now"? Try: noiseless line from the labelled onset level,
// and the rounded level_final_pct. Eval-only.
import { readdirSync, existsSync } from 'node:fs';
import { loadFolder } from '../../../worker/src/folder';
import { readAnswerKey } from '../answerKey';
import { planSystem } from '../../../core/src/planner';
import { tEnd } from '../../../core/src/telemetry';

for (const name of readdirSync('data/eog').sort()) {
  const dir = `data/eog/${name}`;
  if (!existsSync(`${dir}/answer_key.json`) || name === 'full_week') continue;
  const d = loadFolder(dir);
  const now = tEnd(d.grid);
  const ong = readAnswerKey(dir)!.filter((e) => e.category === 'pump_failure' && e.status === 'ongoing');
  const bySys = new Map<string, typeof ong>();
  for (const e of ong) bySys.set(e.system, [...(bySys.get(e.system) ?? []), e]);
  for (const [sys, evs] of bySys) {
    for (const mode of ['line', 'final'] as const) {
      const failures = evs.map((e) => {
        const f = d.model.facilityById.get(e.facility)!;
        const line = e.levelPct! + ((f.baselineInflowBpd / 24 / f.capacityBbl) * 100 * (now - e.onsetUnix)) / 3600;
        return { eventId: e.id, facilityId: e.facility, levelPct: mode === 'line' ? line : e.levelFinalPct!, repairEndUnix: e.onsetUnix + d.model.repairHoursPumpFailure * 3600 };
      });
      const p = planSystem({ model: d.model, systemId: sys, nowUnix: now, failures });
      console.log(name, sys, mode.padEnd(5), `$${p.totalCost.toFixed(0)}`, p.facilities.map((f) => `${f.eventId}: ${f.summary}`).join(' | '));
    }
    console.log('   ref', evs.map((e) => `${e.id}: ${e.referenceActionRaw.split(' (shares')[0]}`).join(' | '));
  }
}
