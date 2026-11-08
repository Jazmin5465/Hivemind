// npx tsx scripts/live-smoke.ts — connect the frontend's live store to the running backend and
// print what the dashboard, fleets and timeline would show. Same code the browser runs.
import { LiveStore } from '@/lib/live/store';
import {
  fleetTrucks, fleets, fmtCountdown, formatTime, historyNodes, longTermRecommendation, mapModel, nowOf, pendingPriority, priorityQueue,
} from '@/lib/live/derive';

const store = new LiveStore(process.env['VITE_SPACETIME_URI'] ?? 'ws://127.0.0.1:3000', process.env['VITE_SPACETIME_DB'] ?? 'hivemind');
store.start();
const t0 = Date.now();
await new Promise<void>((resolve, reject) => {
  const check = () => {
    const s = store.getSnapshot();
    if (s.status === 'error') reject(new Error(s.error));
    if (s.ready) resolve();
  };
  store.subscribe(check);
  setTimeout(() => reject(new Error('timed out waiting for live data')), 15_000);
});
const live = store.getSnapshot();
console.log(`connected in ${Date.now() - t0} ms · dataset ${live.dataset?.datasetId} · now ${formatTime(nowOf(live))}`);
console.log(`rows: ${live.systems.length} systems, ${live.facilities.length} facilities, ${live.events.length} events, ${live.plans.length} plans, ${live.decisions.length} decisions, ${live.fleetSweep.length} fleet-sweep rows`);
console.log('PRIORITY QUEUE');
for (const [i, item] of pendingPriority(priorityQueue(live), live.decisions).entries())
  console.log(`  ${String(i + 1).padStart(2, '0')} ${item.scenario ? 'WATCH ' : 'ACTIVE'} ${item.title.padEnd(18)} ${item.facility.padEnd(16)} ${item.seconds === undefined ? (item.category === 'pipeline_leak' ? 'Active leak' : 'Inspection needed') : fmtCountdown(item.seconds)}`);
console.log('FLEETS');
for (const f of fleets(live)) {
  const busy = fleetTrucks(live, f).filter((t) => t.status !== 'Standby').length;
  console.log(`  ${f.name}: ${f.trucks - busy} of ${f.trucks} available`);
}
console.log('LONG TERM', longTermRecommendation(live)?.reason ?? 'none');
const m = mapModel(live);
console.log(`MAP ${m.W}x${m.H}: ${m.nodes.length} nodes, ${m.nodes.filter((n) => n.status === 'fail').length} failing, ${m.edges.filter((e) => e.failing).length} failing edges`);
console.log(`TIMELINE ${historyNodes(live).length} event nodes`);

if (process.argv.includes('--flow')) {
  // popup flow on the first live pump failure: options -> approve optimal -> queue/fleet update -> undo
  const until = (pred: () => boolean, ms = 10_000) =>
    new Promise<void>((res, rej) => {
      const t = setInterval(() => pred() && (clearInterval(t), res()), 50);
      setTimeout(() => (clearInterval(t), rej(new Error('timeout'))), ms);
    });
  const { optionPlans, planToOption } = await import('@/lib/live/derive');
  const item = priorityQueue(live).find((i) => i.category === 'pump_failure');
  if (!item) throw new Error('no live pump failure at this clock');
  const ds = live.dataset!.datasetId;
  await store.reducers.requestPlanOptions({ datasetId: ds, systemId: item.systemId, facilityId: undefined });
  await until(() => optionPlans(store.getSnapshot(), item.systemId, '').length === 4);
  const opts = optionPlans(store.getSnapshot(), item.systemId, '').map((p) => planToOption(store.getSnapshot(), p));
  console.log(`FLOW options for ${item.systemId}: ${opts.map((o) => `${o.key}=$${Math.round(o.cost)}`).join(', ')}`);
  const best = [...opts].sort((a, b) => a.cost - b.cost)[0]!;
  await store.reducers.approvePlan({ planId: best.planId! });
  await until(() => pendingPriority(priorityQueue(store.getSnapshot()), store.getSnapshot().decisions).every((i) => i.systemId !== item.systemId || i.scenario));
  const after = store.getSnapshot();
  const f = fleets(after).find((x) => x.id === item.systemId)!;
  console.log(`FLOW approved plan ${best.planId} ($${Math.round(best.cost)}): ${after.decisions.filter((d) => d.status === 'active').length} active decisions; ${item.systemId} trucks: ${fleetTrucks(after, f).map((t) => t.status).join(', ')}; queue now ${pendingPriority(priorityQueue(after), after.decisions).length} items`);
  await store.reducers.rejectPlan({ planId: best.planId!, reason: 'smoke test undo' });
  await store.reducers.prunePlans({ datasetId: ds });
  await until(() => store.getSnapshot().decisions.filter((d) => d.planId === best.planId).every((d) => d.status === 'revoked'));
  console.log('FLOW undone (plan rejected, decisions revoked)');
}
store.stop();
process.exit(0);
