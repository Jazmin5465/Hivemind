import { describe, expect, it } from 'vitest';
import { planSystem } from '../src/planner';
import { simulateTank } from '../src/simulate';
import { event9Model } from './fixtures';

const ONSET = 1_791_418_800; // 00:20 UTC
const REPAIR_END = ONSET + 6 * 3600; // 06:20

describe('EVENT_9 worked example (README)', () => {
  const model = event9Model();
  const fac = model.facilityById.get('FAC_C')!;
  const tank = {
    capacityBbl: 800,
    shutdownPct: 92,
    levelPct: 50,
    inflowBpd: fac.baselineInflowBpd,
    horizonMin: 360,
    facilityRevenuePerHour: fac.revenuePerHour,
  };

  it('fills at 75 bbl/h and trips at 04:49', () => {
    const r = simulateTank(tank, null, null);
    expect(fac.baselineInflowBpd / 24).toBeCloseTo(75, 6);
    expect(r.tripMin).toBeCloseTo(268.8, 1);
  });

  it('do nothing costs $5,016', () => {
    expect(simulateTank(tank, null, null).totalCost).toBeCloseTo(5016, 0);
  });

  it('shutting in W_C2 at 02:25 costs ~$1,958 and prevents the trip', () => {
    const w = model.wellById.get('W_C2')!;
    expect(w.revenuePerHour).toBeCloseTo(500, 6);
    const r = simulateTank(tank, null, { waterBpd: w.baselineWaterBpd, revenuePerHour: w.revenuePerHour, startMin: 125 });
    expect(r.tripMin).toBeNull();
    expect(r.totalCost).toBeCloseTo(1958.33, 1);
    // one minute later trips
    expect(simulateTank(tank, null, { waterBpd: 700, revenuePerHour: 500, startMin: 126 }).tripMin).not.toBeNull();
  });

  it('one truck trip arrives 01:35 and costs $905', () => {
    const r = simulateTank(tank, { trucks: 1, tripsPerTruck: 1, responseMin: 75, cycleMin: 230, capacityBbl: 150, costPerTrip: 905 }, null);
    expect(r.tripMin).toBeNull();
    expect(r.arrivalsMin).toEqual([75]);
    expect(r.totalCost).toBe(905);
  });

  it('planner picks 1 truck, 1 trip ($905)', () => {
    const plan = planSystem({ model, systemId: 'SX', nowUnix: ONSET, failures: [{ eventId: 'E9', facilityId: 'FAC_C', levelPct: 50, repairEndUnix: REPAIR_END }] });
    const f = plan.facilities[0];
    expect(plan.totalCost).toBe(905);
    expect(f.actions).toEqual([{ type: 'dispatch_truck', facilityId: 'FAC_C', trucks: 1, tripsPerTruck: 1 }]);
    expect(f.truckArrivalsUnix).toEqual([ONSET + 75 * 60]);
    expect(f.truckFreeAtUnix).toEqual([ONSET + (75 + 230) * 60]); // free again at 05:25
    expect(f.doNothingCost).toBeCloseTo(5016, 0);
    expect(f.tripsAtUnix).toBeNull();
    expect(plan.stats.ms).toBeLessThan(1000);
  });

  it('latest call time: the truck must still arrive before the 04:49 trip (75 min drive) -> call by +193 min', () => {
    const plan = planSystem({ model, systemId: 'SX', nowUnix: ONSET, failures: [{ eventId: 'E9', facilityId: 'FAC_C', levelPct: 50, repairEndUnix: REPAIR_END }] });
    expect(plan.facilities[0].latestDispatchUnix).toBe(ONSET + 193 * 60);
    const noTrucks = planSystem({ model, systemId: 'SX', nowUnix: ONSET, failures: [{ eventId: 'E9', facilityId: 'FAC_C', levelPct: 50, repairEndUnix: REPAIR_END }], overrides: { noTrucks: true } });
    expect(noTrucks.facilities[0].latestDispatchUnix).toBeNull();
  });

  it('with no trucks the planner shuts in W_C2 at +125 min (~$1,958)', () => {
    const plan = planSystem({ model, systemId: 'SX', nowUnix: ONSET, failures: [{ eventId: 'E9', facilityId: 'FAC_C', levelPct: 50, repairEndUnix: REPAIR_END }], overrides: { noTrucks: true } });
    const f = plan.facilities[0];
    expect(f.shutInWells).toEqual(['W_C2']);
    expect(f.actions[0]).toMatchObject({ type: 'shut_in_wells', wells: ['W_C2'], startAfterMin: 125 });
    expect(f.cost).toBeCloseTo(1958.33, 1);
  });

  it('busy trucks are unavailable', () => {
    const plan = planSystem({
      model, systemId: 'SX', nowUnix: ONSET,
      failures: [{ eventId: 'E9', facilityId: 'FAC_C', levelPct: 50, repairEndUnix: REPAIR_END }],
      busyTruckFreeAtUnix: [ONSET + 3600, ONSET + 7200],
    });
    expect(plan.trucksAvailable).toBe(0);
    expect(plan.facilities[0].trucks).toBe(0);
  });

  it('a tank that never trips gets "none" at $0', () => {
    const plan = planSystem({ model, systemId: 'SX', nowUnix: ONSET, failures: [{ eventId: 'E', facilityId: 'FAC_C', levelPct: 20, repairEndUnix: REPAIR_END }] });
    expect(plan.totalCost).toBe(0);
    expect(plan.facilities[0].actions[0].type).toBe('none');
  });

  it('trips arriving after the repair ends are not counted', () => {
    const r = simulateTank({ ...tank, horizonMin: 70 }, { trucks: 1, tripsPerTruck: 1, responseMin: 75, cycleMin: 230, capacityBbl: 150, costPerTrip: 905 }, null);
    expect(r.arrivalsMin).toEqual([]);
    expect(r.violations.length).toBe(1);
  });
});
