// Proactive watch + fleet advice (moved from the frontend into the backend).
import { describe, expect, it } from 'vitest';
import { buildModel } from '../src/model';
import { hoursToShutdownIfPumpStops, longTermAdvice, temporaryAdvice, watchList } from '../src/fleetAdvice';
import type { FleetSweepRow } from '../src/fleetSweep';

function model(systems: { id: string; yard: [number, number]; fleet: number; facilities: string[] }[]) {
  const network = {
    defaults: { tank_limits_pct: { warning: 85, shutdown: 92 } },
    systems: systems.map((s) => ({
      id: s.id,
      center: s.yard,
      truck_yard: s.yard,
      disposal_site: { id: `${s.id}_D`, lat: s.yard[0], lon: s.yard[1], pressure_psi: 1000 },
      facilities: s.facilities.map((f) => ({
        id: f, lat: s.yard[0], lon: s.yard[1],
        wells: [{ id: `${f}_W1`, baseline_water_bpd: 2400, oil_bpd: 100, gas_mcfd: 100 }],
        tank: { id: `${f}_T`, capacity_bbl: 1200 },
        pump: { id: `${f}_P`, max_flow_bpd: 3600, start_level_pct: 70, stop_level_pct: 30 },
        pipeline: { id: `${f}_L`, max_bpd: 4000, max_pressure_psi: 1700 },
      })),
    })),
  };
  const ops = {
    prices: { oil_per_bbl: 60, gas_per_mcf: 3 },
    expected_repair_hours: { pump_failure: 6 },
    emergency_trucking: { truck_capacity_bbl: 150, cost_per_trip: 905 },
    systems: Object.fromEntries(systems.map((s) => [s.id, { emergency_fleet_size: s.fleet, facilities: Object.fromEntries(s.facilities.map((f) => [f, { response_min: 60, cycle_min: 200 }])) }])),
  };
  return buildModel(network, ops);
}

describe('proactive watch', () => {
  it('hours to shutdown if the pump stopped: 1200 bbl at 2400 bpd from 50% to 92% = 5.04 h', () => {
    expect(hoursToShutdownIfPumpStops(50, 1200, 2400, 92)).toBeCloseTo(5.04, 2);
    expect(hoursToShutdownIfPumpStops(50, 1200, 0, 92)).toBeNull();
  });
  it('lists the soonest healthy tanks, never one whose pump already failed', () => {
    const m = model([{ id: 'S1', yard: [32, -102], fleet: 2, facilities: ['A', 'B', 'C', 'D'] }]);
    const w = watchList(m, [
      { facilityId: 'A', levelPct: 80, inflowBpd: 2400 },
      { facilityId: 'B', levelPct: 50, inflowBpd: 2400 },
      { facilityId: 'C', levelPct: 90, inflowBpd: 2400 },
      { facilityId: 'D', levelPct: 60, inflowBpd: 2400 },
    ], new Set(['C']));
    expect(w.map((x) => x.facilityId)).toEqual(['A', 'D', 'B']);
  });
});

describe('fleet advice', () => {
  const m = model([
    { id: 'S1', yard: [32, -102], fleet: 2, facilities: ['S1A'] },
    { id: 'S2', yard: [32.1, -102], fleet: 2, facilities: ['S2A'] },
    { id: 'S3', yard: [35, -100], fleet: 3, facilities: ['S3A'] },
  ]);
  it('a system with every truck out borrows from the nearest one with >= 2 on standby', () => {
    const t = temporaryAdvice(m, new Map([['S1', 0], ['S2', 2], ['S3', 3]]));
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ kind: 'temporary', fromSystem: 'S2', toSystem: 'S1' });
    expect(temporaryAdvice(m, new Map([['S1', 0], ['S2', 1], ['S3', 1]]))).toHaveLength(0);
  });
  it('long-term move comes from the fleet sweep', () => {
    const row = (systemId: string, fleetSize: number, totalCost: number, isCurrent: boolean): FleetSweepRow => ({ systemId, fleetSize, totalCost, isCurrent, failures: 3, trips: 0, truckTrips: 0, wellsShutIn: 0 });
    const lt = longTermAdvice(m, [row('S2', 1, 5568, false), row('S2', 2, 5175, true), row('S2', 3, 2715, false), row('S3', 2, 905, false), row('S3', 3, 905, true), row('S3', 4, 905, false)]);
    expect(lt).toMatchObject({ kind: 'long_term', fromSystem: 'S3', toSystem: 'S2', savings: 2460 });
    expect(longTermAdvice(m, [row('S2', 1, 1000, false), row('S2', 2, 900, true), row('S2', 3, 900, false)])).toBeNull();
  });
});
