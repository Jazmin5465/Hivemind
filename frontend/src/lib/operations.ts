import { datasetNow, detectedEvents, facilityReadings, formatDuration, formatTime, readingsAt, hoursToLimit, operatingCosts as ops, thresholds, type Severity } from './hive-data';

export interface PriorityItem {
  id: string; facility: string; asset: string; category: 'pump_failure' | 'pump_degradation' | 'pipeline_leak' | 'tank_fill';
  title: string; detail: string; severity: Severity; seconds?: number | undefined; scenario: boolean; onset: number;
}
const rank: Record<Severity, number> = { critical: 0, high: 1, medium: 2 };
export function sortPriority(items: PriorityItem[]) {
  return [...items].sort((a, b) => rank[a.severity] - rank[b.severity] || (a.seconds ?? Infinity) - (b.seconds ?? Infinity) || a.id.localeCompare(b.id));
}
export function pendingPriority(items: PriorityItem[], decisions: {queue_id: string}[]) {
  return items.filter(item => !decisions.some(decision => decision.queue_id === item.id));
}
const active = detectedEvents.filter(e => e.end === undefined);
export const priorityQueue: PriorityItem[] = sortPriority([
  ...active.map((e): PriorityItem => {
    const f = facilityReadings.find(f => f.id === e.facility);
    const seconds = f && e.category === 'pump_failure' ? hoursToLimit(f.readings[0] ?? 0, f.tank.capacity_bbl, f.readings[4] ?? 0) * 3600 : undefined;
    return { id: `${e.asset}:${e.onset}`, asset: e.asset, facility: e.facility, category: e.category, onset: e.onset, seconds, scenario: false,
      severity: e.category === 'pump_degradation' ? 'high' : 'critical',
      title: e.category === 'pipeline_leak' ? 'Pipeline leak' : e.category === 'pump_degradation' ? 'Pump wear' : 'Pump failure',
      detail: e.category === 'pipeline_leak' ? 'Sustained flow imbalance · urgent inspection' : e.category === 'pump_degradation' ? 'Reduced pump capacity · inspection required' : 'Pump stopped · tank filling' };
  }),
  ...facilityReadings.filter(f => !active.some(e => e.facility === f.id && e.category === 'pump_failure')).map((f): PriorityItem => ({
    id: `fill:${f.id}:${datasetNow}`, asset: f.tank.id, facility: f.id, category: 'tank_fill', onset: datasetNow, scenario: true,
    title: 'Tank fill exposure', severity: 'medium', seconds: hoursToLimit(f.readings[0] ?? 0, f.tank.capacity_bbl, f.readings[4] ?? 0) * 3600,
    detail: 'If the pump stops · constant inflow scenario',
  })).filter(f => Number.isFinite(f.seconds)).sort((a,b) => (a.seconds ?? Infinity) - (b.seconds ?? Infinity)).slice(0, 3),
]);

export interface SimulationInput {
  level: number; capacity: number; inflow: number; hours: number; responseMin: number; cycleMin: number; trucks: number;
  wells: { id: string; water: number; oil_bpd: number; gas_mcfd: number; active: boolean }[];
}
export interface PlanResult { cost: number; truckingCost: number; revenueLoss: number; trips: number; shutdownHours: number | null; finalLevel: number; }
// Exact event-time integration: pickups cannot prevent a shut-in that occurred before arrival.
export function simulatePlan(input: SimulationInput, shutWells: string[], trucks: number): PlanResult {
  const horizon = Math.max(0, input.hours);
  const limit = input.capacity * thresholds.shutdown / 100;
  let inventory = Math.max(0, input.level * input.capacity / 100), t = 0;
  const selected = input.wells.filter(w => w.active && shutWells.includes(w.id));
  const hourlyRevenue = (w: SimulationInput['wells'][number]) => (w.oil_bpd * ops.prices.oil_per_bbl + w.gas_mcfd * ops.prices.gas_per_mcf) / 24;
  const earlyLoss = selected.reduce((s,w) => s + hourlyRevenue(w), 0) * horizon;
  const remainingRevenue = input.wells.filter(w => w.active && !shutWells.includes(w.id)).reduce((s,w) => s + hourlyRevenue(w),0);
  const rate = Math.max(0, input.inflow - selected.reduce((s,w) => s + w.water, 0)) / 24;
  const count = Math.min(input.trucks, Math.max(0, Math.floor(trucks)));
  const arrivals: number[] = [];
  if (input.cycleMin > 0) for (let n = 0; n < count; n++) for (let h = Math.max(0, input.responseMin / 60); h < horizon; h += input.cycleMin / 60) arrivals.push(h);
  arrivals.sort((a,b) => a-b);
  let trips = 0, shutdown: number | null = inventory >= limit ? 0 : null;
  for (const end of [...arrivals, horizon]) {
    if (shutdown !== null) break;
    const reaches = rate > 0 ? t + Math.max(0, limit - inventory) / rate : Infinity;
    if (reaches <= end && reaches < horizon) { inventory = limit; shutdown = reaches; break; }
    inventory += rate * (end - t); t = end;
    if (end < horizon && inventory + rate * (horizon - end) >= limit && inventory > 0) {
      inventory = Math.max(0, inventory - ops.emergency_trucking.truck_capacity_bbl); trips++;
    }
  }
  const revenueLoss = earlyLoss + (shutdown === null ? 0 : remainingRevenue * (horizon - shutdown));
  const truckingCost = trips * ops.emergency_trucking.cost_per_trip;
  return { cost: Math.round(revenueLoss + truckingCost), revenueLoss: Math.round(revenueLoss), truckingCost, trips, shutdownHours: shutdown, finalLevel: input.capacity > 0 ? inventory / input.capacity * 100 : 0 };
}
export type PlanKey = 'automatic' | 'selective' | 'trucks' | 'combined' | 'inspect';
export interface DecisionPlan extends PlanResult { key: PlanKey; label: string; detail: string; wellIds: string[]; trucks: number; }
export function simulationInput(item: PriorityItem, availableTrucks?: number): SimulationInput {
  const f = facilityReadings.find(f => f.id === item.facility);
  if (!f) throw new Error('Unknown facility');
  const system = ops.systems[f.system as keyof typeof ops.systems];
  const logistics = (system.facilities as Record<string, {response_min: number; cycle_min: number}>)[f.id];
  const hours = item.scenario ? ops.expected_repair_hours.pump_failure : Math.max(0, ops.expected_repair_hours.pump_failure - (datasetNow - item.onset)/3600);
  return { level: f.readings[0] ?? 0, capacity: f.tank.capacity_bbl, inflow: f.readings[4] ?? 0, hours,
    responseMin: logistics?.response_min ?? 0, cycleMin: logistics?.cycle_min ?? 1, trucks: availableTrucks ?? system.emergency_fleet_size,
    wells: f.wells.map((w,i) => ({...w, water: f.readings[7+i] ?? 0, active: f.readings[10+i] === 1})) };
}
export function decisionPlans(item: PriorityItem, availableTrucks?: number): DecisionPlan[] {
  if (item.category === 'pipeline_leak' || item.category === 'pump_degradation') return [{key:'inspect', label: 'Send inspector', detail: item.category === 'pipeline_leak' ? 'Urgent leak inspection · pump continues moving water' : 'Inspect pump wear · no alternate disposal needed', wellIds: [], trucks: 0, cost: 0, revenueLoss: 0, truckingCost: 0, trips: 0, shutdownHours: null, finalLevel: 0}];
  const input = simulationInput(item, availableTrucks);
  const wells = input.wells.filter(w => w.active);
  const subsets = Array.from({length: 2 ** wells.length - 1}, (_,m) => wells.filter((_,i) => ((m+1) & (1 << i)) > 0).map(w => w.id));
  const build = (key: PlanKey, label: string, wellIds: string[], trucks: number): DecisionPlan => {
    const result = simulatePlan(input, wellIds, trucks);
    const names = wellIds.length ? `Shut in ${wellIds.join(', ')} now` : 'Wells continue producing';
    return {...result, key, label, wellIds, trucks, detail: `${names} · ${result.trips} haul trips · ${result.shutdownHours === null ? 'no automatic shut-in before repair' : `all remaining wells shut in after ${result.shutdownHours.toFixed(2)}h`}`};
  };
  const best = (plans: DecisionPlan[]) => plans.sort((a,b) => a.cost-b.cost || a.trucks-b.trucks)[0];
  const plans = [build('automatic', 'Do nothing', [], 0)];
  const selective = best(subsets.map(ids => build('selective', 'Shut in selected wells', ids, 0)));
  if (selective) plans.push(selective);
  const counts = Array.from({length: Math.max(0,input.trucks)}, (_,i) => i+1);
  const hauling = best(counts.map(n => build('trucks', 'Send trucks', [], n)));
  const combined = best(subsets.flatMap(ids => counts.map(n => build('combined', 'Wells + trucks', ids, n))));
  if (hauling) plans.push(hauling);
  if (combined) plans.push(combined);
  return plans;
}

export interface HistoryNode { id: string; ts: number; title: string; detail: string; kind: 'sensor' | 'recovery' | 'now' | 'forecast' | 'decision'; category?: string; system?: string; parentId?: string; relation?: string; recordedAt?: string; }
export const historyNodes: HistoryNode[] = [
  ...detectedEvents.flatMap((e): HistoryNode[] => {
    const id = `${e.asset}:${e.onset}`;
    const f = facilityReadings.find(x => x.id === e.facility);
    const max = f?.pump.max_flow_bpd ?? 0;
    const [tank = 0, , flow = 0, received = 0, inflow = 0, , line = 0] = readingsAt(e.facility, e.onset);
    const tankText = `Tank ${tank.toFixed(0)}% · inflow ${inflow.toFixed(0)} bpd`;
    const detail = e.category === 'pipeline_leak'
      ? `Loss ${(flow-received).toFixed(0)} bpd (${flow.toFixed(0)} pumped → ${received.toFixed(0)} received) · line ${line.toFixed(0)} psi · ${tankText}`
      : e.category === 'pump_failure'
        ? `Pump offline (${flow.toFixed(0)} of ${max} bpd) · ${tankText}`
        : `Flow ${flow.toFixed(0)} of ${max} bpd (${max ? Math.round((1-flow/max)*100) : 0}% below rated) · ${tankText}`;
    const durationText = e.end === undefined ? ` · active ${formatDuration(datasetNow - e.onset)}` : '';
    const nodes: HistoryNode[] = [{id, ts:e.onset, title:`${e.asset} · ${e.category.replaceAll('_',' ')}`, detail: detail + durationText, category:e.category, kind:'sensor', system:e.facility.slice(0,2)}];
    if (e.end !== undefined) {
      const [rt = 0, , rf = 0] = readingsAt(e.facility, e.end);
      nodes.push({id:`${id}:recovery`, ts:e.end, title:`${e.asset} · recovered`, detail:`Resolved in ${formatDuration(e.end - e.onset)} · flow ${rf.toFixed(0)} bpd · tank ${rt.toFixed(0)}%`, category:'recovery', kind:'recovery', system:e.facility.slice(0,2), parentId:id, relation:`Recovery from previous incident at ${formatTime(e.onset)}`});
    }
    return nodes;
  }),
];
export function sortHistory(nodes: HistoryNode[]) {
  return [...nodes].sort((a,b) => b.ts-a.ts || (b.recordedAt ?? '').localeCompare(a.recordedAt ?? '') || a.id.localeCompare(b.id));
}