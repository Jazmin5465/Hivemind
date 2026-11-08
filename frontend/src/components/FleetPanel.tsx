import { MapPin, Truck, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useLive } from '@/components/LiveProvider';
import { fleetTrucks, formatDuration, formatTime, nowOf, type Fleet, type TruckStatus } from '@/lib/live/derive';

/** A truck moving along its job: dispatch -> arrives at the facility (pin) -> back at the yard. */
export function TruckProgress({ truck, now }: { truck: TruckStatus; now: number }) {
  const pct = Math.round((truck.progress ?? 0) * 100);
  const arrival = (truck.arrivalAt ?? 0) * 100;
  const left = Math.max(0, (truck.back ?? now) - now);
  const label = truck.status === 'En route' ? `En route · arrives ${formatTime(truck.eta!)}` : `Hauling · back around ${formatTime(truck.back!)}`;
  return <div className="mt-2" role="progressbar" aria-label={`${truck.unit} job progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-valuetext={`${pct}% · ${label}`}>
    <div className="relative h-6">
      {/* track */}
      <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-gradient-to-r from-accent/60 to-accent transition-[width] duration-1000 ease-linear" style={{ width: `${pct}%` }} />
      </div>
      {/* facility arrival marker */}
      <MapPin aria-hidden className="absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 text-primary" style={{ left: `${arrival}%` }} />
      {/* the truck */}
      <Truck aria-hidden className="absolute top-1/2 size-5 -translate-x-1/2 -translate-y-1/2 text-accent drop-shadow-[0_0_4px_var(--accent)] transition-[left] duration-1000 ease-linear animate-pulse" style={{ left: `${pct}%` }} />
    </div>
    <div className="mt-1 flex justify-between font-mono text-[10px] text-muted-foreground">
      <span>{label}</span>
      <span>{pct}% · {formatDuration(left)} left</span>
    </div>
  </div>;
}

export function FleetPanel({ fleet, now, close }: { fleet: Fleet; now?: number; close: () => void }) {
  const live = useLive();
  const t = now ?? nowOf(live);
  const trucks = fleetTrucks(live, fleet, t);
  const logistics = live.opsFacilities.filter((f) => f.systemId === fleet.id);
  return <div role="region" aria-label={`${fleet.name} truck status`} className="mt-3 rounded-md border border-accent/60 bg-card p-4">
    <div className="mb-3 flex items-center justify-between"><h3 className="font-mono text-sm font-semibold">{fleet.name}</h3><Button variant="ghost" size="icon" aria-label="Close fleet details" onClick={close}><X /></Button></div>
    <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
      {trucks.map(tr => <li key={tr.unit} className="rounded border border-border p-3 text-sm">
        <div className="flex items-center gap-2 font-mono"><Truck className="size-4 text-muted-foreground" />{tr.unit}{tr.status === 'Standby' && <span className="ml-auto rounded bg-ok/15 px-2 py-0.5 text-xs text-ok">Standby</span>}</div>
        {tr.status === 'Standby' ? <p className="mt-2 text-xs text-muted-foreground">At truck yard, ready to dispatch</p> : <>
          <p className="mt-2 text-xs text-muted-foreground">To <span className="font-mono text-foreground">{tr.facility}</span> · {tr.trips} trip{tr.trips === 1 ? '' : 's'} · dispatched {formatTime(tr.dispatch!)}</p>
          <TruckProgress truck={tr} now={t} />
        </>}
      </li>)}
    </ul>
    <p className="mb-2 mt-4 font-mono text-xs uppercase text-muted-foreground">Arrival from yard</p>
    <div className="flex flex-wrap gap-x-5 gap-y-1 font-mono text-xs">{logistics.map((l) => <span key={l.facilityId}>{l.facilityId.replace(`${fleet.id}_`, '')} <span className="text-muted-foreground">{l.responseMin}m · round trip {(l.cycleMin / 60).toFixed(1)}h</span></span>)}</div>
  </div>;
}
