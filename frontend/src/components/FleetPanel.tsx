import { Truck, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import ops from '@/data/ops.json';
import { datasetNow, formatTime, type Fleet } from '@/lib/hive-data';
import { priorityQueue, decisionPlans } from '@/lib/operations';
import type { BrowserDecision } from '@/lib/browser-decisions';

type TruckStatus = { unit: string; status: 'Standby' | 'En route' | 'Hauling'; facility?: string; eta?: number; back?: number; trips?: number };

/** Each truck's status, derived from hauling plans submitted for this fleet's system. */
export function fleetTrucks(fleet: Fleet, decisions: BrowserDecision[], now = datasetNow): TruckStatus[] {
  const sys = ops.systems[fleet.id as keyof typeof ops.systems];
  const trucks: TruckStatus[] = Array.from({ length: fleet.trucks }, (_, i) => ({ unit: `TRK-${fleet.id}-${String.fromCharCode(65 + i)}`, status: 'Standby' }));
  let next = 0;
  for (const d of [...decisions].sort((a, b) => a.dataset_ts - b.dataset_ts)) {
    const item = priorityQueue.find(q => q.id === d.queue_id);
    if (!item || !item.facility.startsWith(`${fleet.id}_`)) continue;
    const plan = decisionPlans(item).find(p => p.key === d.option_key);
    if (!plan || !plan.trucks || !plan.trips) continue;
    const log = sys.facilities[item.facility as keyof typeof sys.facilities] as { response_min: number; cycle_min: number } | undefined;
    if (!log) continue;
    const fac = item.facility;
    const perTruck = Math.ceil(plan.trips / plan.trucks);
    for (let k = 0; k < plan.trucks && next < trucks.length; k++, next++) {
      const eta = d.dataset_ts + log.response_min * 60;
      const back = eta + perTruck * log.cycle_min * 60;
      if (back <= now) continue;
      trucks[next] = { unit: `TRK-${fleet.id}-${String.fromCharCode(65 + next)}`, status: now < eta ? 'En route' : 'Hauling', facility: fac, eta, back, trips: perTruck };
    }
  }
  return trucks;
}

export function FleetPanel({ fleet, decisions, close }: { fleet: Fleet; decisions: BrowserDecision[]; close: () => void }) {
  const trucks = fleetTrucks(fleet, decisions);
  const sys = ops.systems[fleet.id as keyof typeof ops.systems];
  return <div role="region" aria-label={`${fleet.name} truck status`} className="mt-3 rounded-md border border-accent/60 bg-card p-4">
    <div className="mb-3 flex items-center justify-between"><h3 className="font-mono text-sm font-semibold">{fleet.name}</h3><Button variant="ghost" size="icon" aria-label="Close fleet details" onClick={close}><X /></Button></div>
    <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
      {trucks.map(t => <li key={t.unit} className="rounded border border-border p-3 text-sm">
        <div className="flex items-center gap-2 font-mono"><Truck className="size-4 text-muted-foreground" />{t.unit}<span className={`ml-auto rounded px-2 py-0.5 text-xs ${t.status === 'Standby' ? 'bg-ok/15 text-ok' : 'bg-accent/15 text-accent'}`}>{t.status}</span></div>
        {t.status === 'Standby' ? <p className="mt-2 text-xs text-muted-foreground">At truck yard, ready to dispatch</p> : <div className="mt-2 space-y-1 text-xs text-muted-foreground">
          <p>To <span className="font-mono text-foreground">{t.facility}</span> · {t.trips} trip{t.trips === 1 ? '' : 's'}</p>
          <p>ETA {formatTime(t.eta!)}</p>
          <p>Back around {formatTime(t.back!)}</p>
        </div>}
      </li>)}
    </ul>
    <p className="mb-2 mt-4 font-mono text-xs uppercase text-muted-foreground">Arrival from yard</p>
    <div className="flex flex-wrap gap-x-5 gap-y-1 font-mono text-xs">{Object.entries(sys.facilities).map(([id, l]) => <span key={id}>{id.replace(`${fleet.id}_`, '')} <span className="text-muted-foreground">{l.response_min}m · round trip {(l.cycle_min / 60).toFixed(1)}h</span></span>)}</div>
  </div>;
}
