import { Truck, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useLive } from '@/components/LiveProvider';
import { fleetTrucks, formatTime, type Fleet } from '@/lib/live/derive';

export function FleetPanel({ fleet, close }: { fleet: Fleet; close: () => void }) {
  const live = useLive();
  const trucks = fleetTrucks(live, fleet);
  const logistics = live.opsFacilities.filter((f) => f.systemId === fleet.id);
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
    <div className="flex flex-wrap gap-x-5 gap-y-1 font-mono text-xs">{logistics.map((l) => <span key={l.facilityId}>{l.facilityId.replace(`${fleet.id}_`, '')} <span className="text-muted-foreground">{l.responseMin}m · round trip {(l.cycleMin / 60).toFixed(1)}h</span></span>)}</div>
  </div>;
}
