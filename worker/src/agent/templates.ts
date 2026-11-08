// Deterministic texts built only from tool results (used with LLM_PROVIDER=template and as the
// guardrail fallback). Every number here is copied from a tool result.
import { hours1, usd } from './context';
import type { PlanSummary } from './tools';

type EventCtx = Record<string, any>;

const CAT: Record<string, string> = {
  pump_failure: 'pump failure',
  pipeline_leak: 'pipeline leak',
  pump_degradation: 'worn pump',
};

export function failureSummary(systemId: string, plan: PlanSummary, events: EventCtx[], whatifs: PlanSummary[]): string {
  const lines: string[] = [];
  const first = [...events].filter((e) => e.hoursToLimitP50 != null).sort((a, b) => a.hoursToLimitP50 - b.hoursToLimitP50)[0];
  lines.push(
    `${systemId}: ${events.map((e) => `${e.facilityId} pump down since ${e.onset}`).join('; ')}.` +
      (first ? ` First to shut in: ${first.facilityId} in ${hours1(first.hoursToLimitP50)} (${first.tripsAt ?? '-'}) at ${first.levelPct}% now.` : ''),
  );
  lines.push(
    `Recommended: ${plan.facilities.map((f) => `${f.facilityId}: ${f.summary}`).join('; ')}. ` +
      `Cost ${usd(plan.totalCost)} vs ${usd(plan.doNothingCost)} if nothing is done (saves ${usd(plan.savings)}).`,
  );
  if (whatifs.length) lines.push(`What-ifs: ${whatifs.map((w) => `${w.label} → ${usd(w.totalCost)}`).join('; ')}.`);
  lines.push('Plan re-checked against fleet, trip timing and tank limits; awaiting operator approval.');
  return lines.join(' ');
}

export function inspectionSummary(e: EventCtx): string {
  const ev = (e.evidence as string[] | undefined)?.slice(0, 2) ?? [];
  return (
    `${e.assetId}: suspected ${CAT[e.category] ?? e.category} since ${e.onset} (confidence ${e.confidencePct}%). ` +
    `Send a field inspector to ${e.facilityId}; the tank is still being pumped, so no trucks are needed.` +
    (ev.length ? ` Evidence: ${ev.join('; ')}.` : '')
  );
}

export function truckDispatch(f: PlanSummary['facilities'][number], plan: PlanSummary): string | null {
  if (!f.trucks) return null;
  return (
    `Truck crew ${plan.systemId}: send ${f.trucks} truck${f.trucks > 1 ? 's' : ''} to ${f.facilityId} now, ` +
    `${f.tripsPerTruck} trip${f.tripsPerTruck > 1 ? 's' : ''}${f.trucks > 1 ? ' each' : ''}; ${f.truckArrivals.length > 1 ? 'loads arrive' : 'load arrives'} ${f.truckArrivals.join(', ')}. ` +
    `Repair expected by ${f.repairEnd}.`
  );
}

export function shutInDispatch(f: PlanSummary['facilities'][number]): string | null {
  if (!f.shutInWells.length || !f.shutInAt) return null;
  return `Field crew ${f.facilityId}: shut in ${f.shutInWells.join(', ')} at ${f.shutInAt} and keep ${f.shutInWells.length > 1 ? 'them' : 'it'} off until the repair ends (${f.repairEnd}).`;
}

export function inspectorDispatch(e: EventCtx): string {
  return `Field inspector: check ${e.assetId} at ${e.facilityId} for a ${CAT[e.category] ?? e.category} (since ${e.onset}).`;
}

export function whatifAnswer(question: string, base: PlanSummary, alt: PlanSummary): string {
  const d = alt.totalCost - base.totalCost;
  const changes = alt.facilities
    .filter((f) => base.facilities.find((b) => b.facilityId === f.facilityId)?.summary !== f.summary)
    .map((f) => `${f.facilityId}: ${f.summary}`);
  return (
    `${base.systemId} with ${alt.label}: best plan costs ${usd(alt.totalCost)} vs ${usd(base.totalCost)} now ` +
    `(${d >= 0 ? `${usd(d)} more` : `${usd(-d)} less`}).` +
    (changes.length ? ` Changes: ${changes.join('; ')}.` : ' The plan itself does not change.') +
    (alt.facilities.some((f) => f.tripsAtUnix != null) ? ' Warning: at least one tank still shuts in.' : '')
  );
}

export function statusAnswer(h: Record<string, any>): string {
  if (!h.ongoingCount) return `No ongoing problems at ${h.now}.`;
  const seen = new Set<number>();
  const top = (h.ongoing as any[]).slice(0, 4).map((x) => itemLine(x, seen));
  return `At ${h.now}: ${top.join(' ')}`;
}

/** one line per alert; a system plan shared by several failures is printed once */
function itemLine(x: Record<string, any>, seenPlans: Set<number>): string {
  if (x.category === 'pump_failure') {
    let plan = '';
    if (x.plan && seenPlans.has(x.plan.planId)) plan = ` Covered by plan #${x.plan.planId} above.`;
    else if (x.plan) {
      seenPlans.add(x.plan.planId);
      plan = ` Plan #${x.plan.planId} (${x.plan.status}) ${usd(x.plan.totalCost)}: ${x.plan.summary}.`;
    }
    return `#${x.alertRank} ${x.facilityId} pump failure, ${x.hoursToLimitP50 != null ? `${hours1(x.hoursToLimitP50)} to shutdown` : 'already shut in'}, repair by ${x.repairEnd}.${plan}${x.owner ? ` Owner ${x.owner}.` : ''}`;
  }
  return `#${x.alertRank} ${x.assetId} ${CAT[x.category] ?? x.category} since ${x.since}: send inspector.${x.owner ? ` Owner ${x.owner}.` : ''}`;
}

export function handoffText(h: Record<string, any>): string {
  const head = `Shift handoff, ${h.datasetId} at ${h.now}.`;
  if (!h.ongoingCount) return `${head} Nothing in progress.${h.resolvedLast12hCount ? ` Problems resolved in the last 12 h: ${h.resolvedLast12h.map((r: any) => r.assetId).join(', ')}.` : ''}`;
  const seen = new Set<number>();
  const items = (h.ongoing as any[]).map((x) => itemLine(x, seen));
  const res = h.resolvedLast12hCount ? ` Recently resolved: ${h.resolvedLast12h.map((r: any) => `${r.assetId} ${CAT[r.category] ?? r.category} (${r.ended})`).join(', ')}.` : '';
  return `${head} ${items.join(' ')}${res}`;
}
