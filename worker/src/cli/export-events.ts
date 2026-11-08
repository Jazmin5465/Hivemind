// npm run export:events -- <folder> [--as-of <unix|ISO>] [--out events.json]
// Writes events.json in the SPEC.md shape, from the same causal pipeline the module runs
// (rules detector; planner for ongoing pump failures, planned jointly per system from "now").
import { writeFileSync } from 'node:fs';
import { loadFolder } from '../folder';
import { analyze } from '../../../core/src/analyze';
import { tEnd } from '../../../core/src/telemetry';

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith('--'));
if (!dir) {
  console.error('usage: npm run export:events -- <folder> [--as-of <unix|ISO>] [--out events.json]');
  process.exit(2);
}
const opt = (k: string) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : undefined;
};
const d = loadFolder(dir);
const asOfArg = opt('--as-of');
const asOf = asOfArg ? (/^\d+$/.test(asOfArg) ? Number(asOfArg) : Math.floor(Date.parse(asOfArg) / 1000)) : tEnd(d.grid);
const out = analyze({ model: d.model, grid: d.grid, asOfUnix: asOf });
const iso = (u: number | null) => (u == null ? null : new Date(u * 1000).toISOString().replace('.000Z', 'Z'));
const round = (v: number | null | undefined, k = 2) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** k) / 10 ** k);

const planByEvent = new Map(out.plans.flatMap((p) => p.facilities.map((f) => [f.eventId, f] as const)));
const events = out.events
  .slice()
  .sort((a, b) => a.onsetUnix - b.onsetUnix)
  .map((e, i) => {
    const plan = planByEvent.get(e.eventId);
    const actions =
      e.category === 'pump_failure'
        ? e.status === 'ongoing' && plan
          ? plan.actions.map((a) =>
              a.type === 'dispatch_truck'
                ? { type: a.type, facility_id: a.facilityId, trucks: a.trucks, trips_per_truck: a.tripsPerTruck }
                : a.type === 'shut_in_wells'
                  ? { type: a.type, wells: a.wells, start_after_min: a.startAfterMin ?? 0 }
                  : { type: 'none' },
            )
          : [{ type: 'none' }]
        : [{ type: 'field_inspection', asset_id: e.assetId }];
    return {
      event_id: `EV-${String(i + 1).padStart(4, '0')}`,
      system_id: e.systemId,
      facility_id: e.facilityId,
      asset_id: e.assetId,
      category: e.category,
      status: e.status,
      onset_ts: iso(e.onsetUnix),
      onset_unix: e.onsetUnix,
      end_ts: iso(e.endUnix),
      end_unix: e.endUnix,
      confidence: round(e.confidence),
      evidence: e.evidence,
      level_pct: e.countdown ? round(e.countdown.levelPct, 1) : null,
      hours_to_limit:
        e.countdown && e.status === 'ongoing' && e.countdown.hoursToLimitP50 != null
          ? { p50: round(e.countdown.hoursToLimitP50), p10: round(e.countdown.hoursToLimitP10), p90: round(e.countdown.hoursToLimitP90) }
          : null,
      recommended_actions: actions,
      ...(plan && e.status === 'ongoing' ? { est_cost: round(plan.cost, 0), alert_order: e.alertRank } : {}),
    };
  });
const file = opt('--out') ?? 'events.json';
writeFileSync(file, JSON.stringify(events, null, 2) + '\n');
console.log(`wrote ${events.length} events (${events.filter((e) => e.status === 'ongoing').length} ongoing) as of ${iso(asOf)} to ${file}`);
