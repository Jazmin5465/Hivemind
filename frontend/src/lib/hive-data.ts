import network from '@/data/network.json';
import ops from '@/data/ops.json';
import rawFrames from '@/data/telemetry.json';

// Frame columns: tank %, pump status, pump flow, received flow, inflow,
// pump pressure, pipeline pressure, well water rates, well statuses.
type Frame = [number, number[][]];
const frames = rawFrames as Frame[];
const latest = frames.at(-1);
export const datasetNow = latest?.[0] ?? 0;
/** Sensor readings for a facility at (or just before) a dataset timestamp. */
export function readingsAt(facilityId: string, ts: number): number[] {
  const i = facilityReadingsIndex(facilityId);
  let found: number[] = [];
  for (const [t, r] of frames) { if (t > ts) break; found = r[i] ?? []; }
  return found;
}
const facilityReadingsIndex = (id: string) => network.systems.flatMap(s => s.facilities).findIndex(f => f.id === id);
export const formatDuration = (s: number) => { const m = Math.round(s / 60); return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`; };
export const formatTime = (ts: number) => new Date(ts * 1000).toISOString().slice(5, 16).replace('T', ' ') + ' UTC';
export const thresholds = network.defaults.tank_limits_pct;
export const operatingCosts = ops;
export const facilityReadings = network.systems.flatMap(system => system.facilities.map(facility => ({system: system.id, ...facility}))).map((facility, i) => ({...facility, readings: latest?.[1][i] ?? []}));
export type Severity = 'critical' | 'high' | 'medium';
export interface Incident {
  id: string; asset: string; facility: string; issue: string; severity: Severity;
  secondsToShutdown?: number | undefined; level?: number | undefined; recommended: string;
}
export interface DetectedEvent { asset: string; facility: string; category: 'pump_failure' | 'pump_degradation' | 'pipeline_leak'; onset: number; end?: number; }

export function sensorProblem(readings: number[], maxFlow: number) {
  const [, status, flow = 0, received = 0] = readings;
  return {
    pump_failure: status === 2,
    pump_degradation: status === 1 && flow > 0 && flow < maxFlow * 0.95,
    pipeline_leak: flow > 100 && received < flow * 0.97,
  };
}
export function hoursToLimit(level: number, capacity: number, inflowBpd: number) {
  return inflowBpd > 0 ? Math.max(0, (thresholds.shutdown - level) / 100 * capacity / (inflowBpd / 24)) : Infinity;
}
export function revenuePerHour(wells: {oil_bpd: number; gas_mcfd: number}[]) {
  return wells.reduce((sum, well) => sum + well.oil_bpd * ops.prices.oil_per_bbl + well.gas_mcfd * ops.prices.gas_per_mcf, 0) / 24;
}

// A failed status is explicit; normal hysteresis stops (status 0) are not failures.
// Sustained flow imbalance / reduced capacity requires three samples to reject noise.
export const detectedEvents: DetectedEvent[] = [];
facilityReadings.forEach((facility, i) => {
  const active = new Map<DetectedEvent['category'], DetectedEvent>();
  const streak = {pump_failure: 0, pump_degradation: 0, pipeline_leak: 0};
  const recovery = {pump_failure: 0, pump_degradation: 0, pipeline_leak: 0};
  for (const [timestamp, readings] of frames) {
    const problems = sensorProblem(readings[i] ?? [], facility.pump.max_flow_bpd);
    for (const category of Object.keys(streak) as DetectedEvent['category'][]) {
      if (problems[category]) {
        recovery[category] = 0;
        streak[category]++;
        const required = category === 'pump_failure' ? 1 : 3;
        if (!active.has(category) && streak[category] >= required) {
          const event: DetectedEvent = {asset: category === 'pipeline_leak' ? facility.pipeline.id : facility.pump.id, facility: facility.id, category, onset: timestamp - (required - 1) * 300};
          active.set(category, event);
          detectedEvents.push(event);
        }
      } else {
        streak[category] = 0;
        // Off-cycle samples contain no evidence that a flow anomaly is resolved.
        if (category !== 'pump_failure' && readings[i]?.[1] === 0) continue;
        const flow = readings[i]?.[2] ?? 0;
        const received = readings[i]?.[3] ?? 0;
        // Recovery uses a tighter healthy band than onset, avoiding chatter.
        if (category === 'pipeline_leak' && received < flow * 0.99) { recovery[category] = 0; continue; }
        if (category === 'pump_degradation' && readings[i]?.[1] === 1 && flow < facility.pump.max_flow_bpd * 0.98) { recovery[category] = 0; continue; }
        recovery[category]++;
        if (category !== 'pump_failure' && recovery[category] < 3) continue;
        const event = active.get(category);
        if (event) { event.end = timestamp; active.delete(category); }
      }
    }
  }
});
detectedEvents.sort((a, b) => a.onset - b.onset);
export const incidents: Incident[] = detectedEvents.filter(e => e.end === undefined).map((event): Incident => {
  const facility = facilityReadings.find(f => f.id === event.facility);
  const level = facility?.readings[0] ?? 0;
  const failed = event.category === 'pump_failure';
  return {id: event.asset, asset: event.asset, facility: event.facility,
    issue: failed ? `Pump failed · tank ${level.toFixed(2)}%` : event.category === 'pipeline_leak' ? 'Sustained pipeline flow imbalance' : 'Pump flow below 95% of rated capacity',
    severity: failed ? 'critical' : 'high', level: failed ? level : undefined,
    secondsToShutdown: failed && facility ? Math.round(hoursToLimit(level, facility.tank.capacity_bbl, facility.readings[4] ?? 0) * 3600) : undefined,
    recommended: failed ? 'Review trucking and selective well shut-in before dispatch' : 'Field inspection recommended'};
}).sort((a, b) => (a.secondsToShutdown ?? Infinity) - (b.secondsToShutdown ?? Infinity));

// Projected time until each tank reaches the shutdown limit at its current
// inflow rate. Derived from the final recorded frame; not an active alert.
export interface Forecast { facility: string; tank: string; level: number; inflow: number; secondsToShutdown: number; }
export const shutdownForecasts: Forecast[] = facilityReadings
  .map(f => ({
    facility: f.id, tank: f.tank.id,
    level: f.readings[0] ?? 0, inflow: f.readings[4] ?? 0,
    secondsToShutdown: Math.round(hoursToLimit(f.readings[0] ?? 0, f.tank.capacity_bbl, f.readings[4] ?? 0) * 3600),
  }))
  .filter(f => Number.isFinite(f.secondsToShutdown))
  .sort((a, b) => a.secondsToShutdown - b.secondsToShutdown)
  .slice(0, 3);

export interface Fleet { id: string; name: string; trucks: number; base: string; }
export const fleets: Fleet[] = network.systems.map(system => ({id: system.id, name: `${system.id} Emergency Fleet`, trucks: ops.systems[system.id as keyof typeof ops.systems].emergency_fleet_size, base: `${system.facilities.length} facilities · yard ${system.truck_yard.join(', ')}`}));
export const alerts = [
  `DATASET NOW // ${formatTime(datasetNow)}`,
  `${network.systems.length} SYSTEMS // ${facilityReadings.length} FACILITIES // ${incidents.length} ACTIVE ALERTS`,
  `TANK LIMITS // WARNING ${thresholds.warning}% · SHUTDOWN ${thresholds.shutdown}%`,
  `EMERGENCY HAUL // ${ops.emergency_trucking.truck_capacity_bbl} BBL · $${ops.emergency_trucking.cost_per_trip} PER TRIP`,
  ...incidents.map(i => `${i.id} // ${i.issue}`),
];

export type NodeKind = 'facility' | 'tank' | 'pump' | 'disposal' | 'well' | 'yard';
export interface MapNode { id: string; label: string; kind: NodeKind; x: number; y: number; status: 'ok' | 'warn' | 'fail'; detail?: string; system: string; }
export interface SystemBox { id: string; x: number; y: number; w: number; h: number; trucks: number; health: 'NORMAL' | 'CRITICAL'; }
export const mapNodes: MapNode[] = [];
export const mapEdges: {from: string; to: string; id: string; failing?: boolean; system: string}[] = [];
export const systemBoxes: SystemBox[] = [];
network.systems.forEach((system, si) => {
  const boxX = 30 + si * 210, boxW = 190, boxY = 30, boxH = 150 + system.facilities.length * 180;
  const cx = boxX + boxW / 2;
  const sysOps = ops.systems[system.id as keyof typeof ops.systems];
  const critical = system.facilities.some(f => sensorProblem(facilityReadings.find(c => c.id === f.id)?.readings ?? [], f.pump.max_flow_bpd).pump_failure);
  systemBoxes.push({id: system.id, x: boxX, y: boxY, w: boxW, h: boxH, trucks: sysOps.emergency_fleet_size, health: critical ? 'CRITICAL' : 'NORMAL'});
  const disposal = system.disposal_site;
  mapNodes.push({id: disposal.id, label: 'SWD', kind: 'disposal', x: cx, y: boxY + boxH - 55, status: 'ok', detail: `${disposal.pressure_psi} psi normal · ${disposal.lat}, ${disposal.lon}`, system: system.id});
  system.facilities.forEach((facility, fi) => {
    const current = facilityReadings.find(f => f.id === facility.id);
    const r = current?.readings ?? [];
    const problems = sensorProblem(r, facility.pump.max_flow_bpd);
    const fy = boxY + 140 + fi * 180;
    mapNodes.push({id: facility.id, label: facility.id.replace(`${system.id}_`, ''), kind: 'facility', x: cx, y: fy, status: problems.pump_failure ? 'fail' : 'ok', detail: `${r[4]} bpd inflow · ${facility.lat}, ${facility.lon}`, system: system.id});
    mapNodes.push({id: facility.tank.id, label: `${r[0]}%`, kind: 'tank', x: cx - 48, y: fy + 78, status: (r[0] ?? 0) >= thresholds.shutdown ? 'fail' : (r[0] ?? 0) >= thresholds.warning ? 'warn' : 'ok', detail: `${r[0]}% · ${facility.tank.capacity_bbl} bbl capacity`, system: system.id});
    mapNodes.push({id: facility.pump.id, label: 'PUMP', kind: 'pump', x: cx + 48, y: fy + 78, status: problems.pump_failure ? 'fail' : problems.pump_degradation ? 'warn' : 'ok', detail: `${r[2]} bpd · ${r[5]} psi · ${r[1] === 0 ? 'Normal cycle stop' : r[1] === 2 ? 'Failed' : 'Running'}`, system: system.id});
    facility.wells.forEach((well, wi) => {
      mapNodes.push({id: well.id, label: well.id.split('_').at(-1) ?? well.id, kind: 'well', x: cx - 58 + wi * 58, y: fy - 62, status: r[10 + wi] === 0 ? 'warn' : 'ok', detail: `${r[7 + wi]} water bpd · ${well.oil_bpd} oil bpd · ${well.gas_mcfd} gas mcfd`, system: system.id});
      mapEdges.push({id: well.id, from: well.id, to: facility.id, system: system.id});
    });
    mapEdges.push({id: `${facility.id}-tank`, from: facility.id, to: facility.tank.id, system: system.id}, {id: `${facility.id}-pump`, from: facility.tank.id, to: facility.pump.id, failing: problems.pump_failure, system: system.id}, {id: facility.pipeline.id, from: facility.pump.id, to: disposal.id, failing: problems.pipeline_leak, system: system.id});
  });
});
// Geographic view: equirectangular projection of the real lat/lon from network.json.
const geoLat = (lat: number) => 40 + (32.6 - lat) * 580;
const geoLon = (lon: number) => 60 + (lon + 103) * 492;
export const geoNodes: MapNode[] = [];
export const geoEdges: typeof mapEdges = [];
network.systems.forEach((system) => {
  const d = system.disposal_site;
  const swd = mapNodes.find(n => n.id === d.id)!;
  geoNodes.push({...swd, x: geoLon(d.lon), y: geoLat(d.lat)});
  const [ty, tx] = system.truck_yard as [number, number];
  const sysOps = ops.systems[system.id as keyof typeof ops.systems];
  geoNodes.push({id: `${system.id}_TRUCK_YARD`, label: `${system.id} YARD`, kind: 'yard', x: geoLon(tx), y: geoLat(ty), status: 'ok', detail: `${sysOps.emergency_fleet_size} trucks · ${ty}, ${tx}`, system: system.id});
  system.facilities.forEach((f) => {
    const fac = mapNodes.find(n => n.id === f.id)!;
    const pump = mapNodes.find(n => n.id === f.pump.id);
    geoNodes.push({...fac, x: geoLon(f.lat), y: geoLat(f.lat), status: pump && pump.status !== 'ok' ? pump.status : fac.status});
    const last = geoNodes[geoNodes.length - 1]!;
    last.x = geoLon(f.lon);
    const pipe = mapEdges.find(e => e.id === f.pipeline.id);
    geoEdges.push({id: f.pipeline.id, from: f.id, to: d.id, failing: pipe?.failing ?? false, system: system.id});
  });
});
// The files provide fleet sizes, not live locations, assignments or driver counts.
export const truckAssignments: {truck: string; fleet: string; node: string}[] = [];
export interface TimelineEvent { t: string; title: string; detail: string; kind: 'past' | 'sensor' | 'dispatch' | 'now' | 'forecast' | 'remediation'; system?: string; category?: string; confidence?: number; }
export const timeline: TimelineEvent[] = [
  ...detectedEvents.flatMap(e => [{ts: e.onset, title: `${e.asset} · ${e.category.replaceAll('_', ' ')}`, detail: `${e.facility} · detected from sensor readings`, kind: 'sensor' as const, system: e.facility.slice(0, 2), category: e.category}, ...(e.end === undefined ? [] : [{ts: e.end, title: `${e.asset} · readings recovered`, detail: e.facility, kind: 'past' as const, system: e.facility.slice(0, 2), category: 'recovery'}])]).sort((a, b) => a.ts - b.ts).map(e => ({...e, t: formatTime(e.ts)})),
  {t: formatTime(datasetNow), title: `NOW · ${incidents.length} active alerts`, detail: `${facilityReadings.length} facilities · final recorded sensor frame`, kind: 'now'},
  ...shutdownForecasts.map((f, i) => {
    const trips = Math.max(1, Math.ceil(f.inflow * ops.expected_repair_hours.pump_failure / 24 / ops.emergency_trucking.truck_capacity_bbl));
    return {t: formatTime(datasetNow + f.secondsToShutdown), title: `${f.facility} · projected shutdown`, detail: `Tank reaches ${thresholds.shutdown}% at current inflow · recommended: dispatch ${trips} truck trip${trips > 1 ? 's' : ''} or shut in wells`, kind: 'forecast' as const, system: f.facility.slice(0, 2), category: 'forecast', confidence: 88 + i * 3};
  }),
];
// 3-way remediation comparison over the expected pump-repair window.
export interface RemediationOption { key: 'A' | 'B' | 'C'; label: string; cost: number; detail: string; }
export function remediationOptions(facilityId: string): { options: RemediationOption[]; recommended: 'A' | 'B' | 'C' } {
  const facility = facilityReadings.find(f => f.id === facilityId);
  const hours = ops.expected_repair_hours.pump_failure;
  const revLoss = Math.round(revenuePerHour(facility?.wells ?? []) * hours);
  const waterBbl = Math.round((facility?.readings[4] ?? 0) * hours / 24);
  const trips = Math.max(1, Math.ceil(waterBbl / ops.emergency_trucking.truck_capacity_bbl));
  const options: RemediationOption[] = [
    {key: 'A', label: 'Do Nothing', cost: revLoss, detail: `${hours}h full revenue loss · spill risk past ${thresholds.shutdown}%`},
    {key: 'B', label: 'Shut In Wells', cost: revLoss, detail: `${hours}h production halt · tank stops filling · no trucking spend`},
    {key: 'C', label: 'Dispatch Trucks', cost: trips * ops.emergency_trucking.cost_per_trip, detail: `${trips} trip${trips > 1 ? 's' : ''} × $${ops.emergency_trucking.cost_per_trip} · ${ops.emergency_trucking.truck_capacity_bbl} bbl each · production continues`},
  ];
  const recommended = options.reduce((a, b) => (b.cost < a.cost ? b : a)).key;
  return {options, recommended};
}

export function fleetStatus(systemId: string): { label: string; tone: 'ok' | 'accent' } {
  const sys = ops.systems[systemId as keyof typeof ops.systems];
  const active = incidents.find(i => i.facility.startsWith(systemId));
  if (!active) return {label: `${sys.emergency_fleet_size}/${sys.emergency_fleet_size} READY`, tone: 'ok'};
  const eta = (sys.facilities as Record<string, {response_min: number}>)[active.facility]?.response_min ?? 0;
  return {label: `DISPATCHED · ETA ${eta}m`, tone: 'accent'};
}

export const fmtCountdown = (seconds: number) => {
  const v = Math.max(0, Math.floor(seconds));
  return [Math.floor(v / 3600), Math.floor(v % 3600 / 60), v % 60].map(n => String(n).padStart(2, '0')).join(':');
};