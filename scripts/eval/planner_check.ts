// Quick planner/countdown check against snapshot answer keys using labelled onsets
// ("oracle onset" mode). Eval-only: this directory is the only place allowed to read answer keys.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadFolder } from '../../worker/src/folder';
import { countdownAt } from '../../core/src/countdown';
import { planSystem } from '../../core/src/planner';
import { orderAlerts } from '../../core/src/alerts';
import { tEnd } from '../../core/src/telemetry';

const root = process.argv[2] ?? 'data/eog';
const costOf = (s: string) => {
  const m = s.match(/~\$([\d,]+)/);
  return m ? Number(m[1].replace(/,/g, '')) : 0;
};
for (const name of readdirSync(root).sort()) {
  const dir = join(root, name);
  const keyPath = join(dir, 'answer_key.json');
  if (!existsSync(keyPath)) continue;
  const key = JSON.parse(readFileSync(keyPath, 'utf8')) as any[];
  const ongoing = key.filter((e) => e.status === 'ongoing' && e.category === 'pump_failure');
  if (!ongoing.length) continue;
  const d = loadFolder(dir);
  const now = tEnd(d.grid);
  console.log(`== ${name} now=${new Date(now * 1000).toISOString()}`);
  const bySys = new Map<string, any[]>();
  for (const e of ongoing) bySys.set(e.system, [...(bySys.get(e.system) ?? []), e]);
  const alerts: any[] = [];
  for (const [sys, evs] of bySys) {
    const failures = evs.map((e) => {
      const cd = countdownAt(d.model, d.grid, e.facility, now, { sinceUnix: e.onset_unix });
      const f = d.model.facilityById.get(e.facility)!;
      alerts.push({ key: e.id, category: 'pump_failure', status: 'ongoing', hoursToLimit: cd.hoursToLimitP50, lostRevenuePerHour: f.revenuePerHour, onsetUnix: e.onset_unix, ref: e.order });
      console.log(
        `  ${e.id} ${e.facility} level ${cd.levelPct.toFixed(1)} (ref ${e.level_final_pct})  h2l p50 ${cd.hoursToLimitP50?.toFixed(2)} [${cd.hoursToLimitP10?.toFixed(2)}, ${cd.hoursToLimitP90?.toFixed(2)}] (ref ${e.hours_to_limit_final}) obsRate ${cd.observedRatePctPerHour?.toFixed(2)} vs ${cd.ratePctPerHour.toFixed(2)}  rev/h ${f.revenuePerHour} (ref ${e.lost_revenue_per_hour})`,
      );
      return { eventId: e.id, facilityId: e.facility, levelPct: cd.levelPct, repairEndUnix: e.onset_unix + d.model.repairHoursPumpFailure * 3600 };
    });
    const plan = planSystem({ model: d.model, systemId: sys, nowUnix: now, failures });
    const refTotal = evs.reduce((a, e) => a + costOf(e.reference_action), 0);
    const verdict = Math.abs(plan.totalCost - refTotal) <= 1.5 ? 'OK' : plan.totalCost < refTotal ? 'CHEAPER?' : 'WORSE';
    console.log(`  ${sys}: ours $${plan.totalCost.toFixed(0)} vs ref $${refTotal}  ${verdict}  (${plan.stats.evaluated} sims, ${plan.stats.ms} ms)`);
    for (const f of plan.facilities) {
      const e = evs.find((x) => x.id === f.eventId);
      console.log(`    ${f.eventId}: ${f.summary} $${f.cost.toFixed(0)} | ref: ${e.reference_action}`);
    }
  }
  const ord = orderAlerts(alerts);
  console.log(`  order: ${ord.map((a, i) => `${a.key}=${i + 1}${a.ref === i + 1 ? '✓' : '✗(ref ' + a.ref + ')'}`).join(' ')}`);
}
