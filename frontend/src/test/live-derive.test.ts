import { describe, expect, it } from 'vitest';
import {
  decisionNodes, fleetTrucks, historyNodes, longTermRecommendation, mapModel, optionPlans, pendingPriority, planToOption,
  priorityQueue, secondsToShutdownIfPumpStops, sortHistory, temporaryRecommendations, watchItems,
} from '@/lib/live/derive';
import { action, decision, event, facility, identity, liveData, NOW, plan, planFacility, state, sweep, system, ts } from './live-fixtures';

const S1 = [system('S1', 32, -102), system('S2', 32.2, -101.8)];
const facs = [facility('S1_FACILITY_A', 'S1'), facility('S1_FACILITY_B', 'S1'), facility('S2_FACILITY_A', 'S2')];

describe('priority queue (live)', () => {
  const live = liveData({
    systems: S1,
    facilities: facs,
    facilityStates: [state('S1_FACILITY_A', 'S1', 70, 2400), state('S1_FACILITY_B', 'S1', 50, 2400), state('S2_FACILITY_A', 'S2', 80, 1200)],
    events: [
      event('e-leak', 'S2_FACILITY_A', 'S2', 'pipeline_leak', { alertRank: 2 }),
      event('e-fail', 'S1_FACILITY_A', 'S1', 'pump_failure', { alertRank: 1, hoursToLimitP50: 1.5 }),
      event('e-old', 'S1_FACILITY_B', 'S1', 'pump_degradation', { status: 'resolved', alertRank: 0 }),
    ],
  });

  it('shows ongoing alerts in the backend alertRank order, then proactive watch items', () => {
    const q = priorityQueue(live);
    expect(q.map((i) => i.id).slice(0, 2)).toEqual(['e-fail', 'e-leak']);
    expect(q[0]?.seconds).toBe(1.5 * 3600); // backend countdown, unchanged
    expect(q.slice(2).every((i) => i.scenario && i.category === 'tank_fill')).toBe(true);
    expect(q.some((i) => i.id === 'e-old')).toBe(false); // resolved events never queue
  });

  it('watch items skip facilities whose pump has already failed', () => {
    const w = watchItems(live);
    expect(w.map((i) => i.facility)).not.toContain('S1_FACILITY_A');
    expect(w[0]?.facility).toBe('S2_FACILITY_A'); // 80% with low inflow vs 50%: compare times
  });

  it('time to shutdown if the pump stops uses live level, live inflow and the dataset limit', () => {
    // 1200 bbl, 2400 bpd -> 8.33 %/h; from 50% to 92% = 5.04 h
    expect(secondsToShutdownIfPumpStops(50, 1200, 2400, 92) / 3600).toBeCloseTo(5.04, 2);
    expect(secondsToShutdownIfPumpStops(50, 1200, 0, 92)).toBe(Infinity);
  });

  it('hides items with an active decision (alerts by event, watch items by contingency)', () => {
    const q = priorityQueue(live);
    const pending = pendingPriority(q, [
      decision(1n, 'e-fail', 'plan'),
      decision(2n, '', 'contingency', { facilityId: q[2]!.facility }),
      decision(3n, 'e-leak', 'inspection', { status: 'revoked' }),
    ]);
    expect(pending.some((i) => i.id === 'e-fail')).toBe(false);
    expect(pending.some((i) => i.id === q[2]!.id)).toBe(false);
    expect(pending.some((i) => i.id === 'e-leak')).toBe(true); // revoked decisions don't count
  });
});

describe('decision popup options (backend plans)', () => {
  const opts = [
    plan(11n, 'S1', { optionKey: 'do_nothing', totalCost: 5000, createdAt: ts(5n) }),
    plan(10n, 'S1', { optionKey: 'optimal', totalCost: 905, createdAt: ts(5n) }),
    plan(12n, 'S1', { optionKey: 'shut_in_only', totalCost: 1958, createdAt: ts(5n) }),
    plan(9n, 'S1', { optionKey: 'optimal', totalCost: 999, createdAt: ts(1n) }), // older batch
    plan(13n, 'S1', { optionKey: 'optimal', createdAt: ts(5n), createdBy: identity('other') }), // another operator
  ];
  const live = liveData({
    plans: opts,
    planActions: [action(10n, 'S1_FACILITY_A', 'dispatch_truck', { trucks: 1, tripsPerTruck: 1 }), action(12n, 'S1_FACILITY_A', 'shut_in_wells', { wells: ['S1_WELL_A2'] })],
    planFacilities: [planFacility(10n, 'S1_FACILITY_A'), planFacility(12n, 'S1_FACILITY_A', { cost: 1958, truckCost: 0, shutInCost: 1958 }), planFacility(11n, 'S1_FACILITY_A', { cost: 5000, truckCost: 0, tripCost: 5000, tripsAtUnix: NOW + 3600 })],
  });

  it("uses only this operator's newest batch, in a fixed order", () => {
    expect(optionPlans(live, 'S1', '').map((p) => p.planId)).toEqual([10n, 12n, 11n]);
  });

  it('turns backend plans into the popup cards with backend costs', () => {
    const [opt, shut, nothing] = optionPlans(live, 'S1', '').map((p) => planToOption(live, p));
    expect(opt).toMatchObject({ label: 'Send trucks', cost: 905, truckingCost: 905, trips: 1, shutdownHours: null });
    expect(shut).toMatchObject({ label: 'Shut in selected wells', cost: 1958, wellIds: ['S1_WELL_A2'] });
    expect(nothing).toMatchObject({ label: 'Do nothing', cost: 5000, revenueLoss: 5000, shutdownHours: 1 });
  });
});

describe('fleets', () => {
  const live = liveData({
    systems: S1,
    opsSystems: [{ key: 'k', datasetId: 'fixture', systemId: 'S1', fleetSize: 2 } as never],
    plans: [plan(20n, 'S1', { status: 'approved', origin: 'planner' })],
    planActions: [action(20n, 'S1_FACILITY_A', 'dispatch_truck', { trucks: 1, tripsPerTruck: 1 })],
    planFacilities: [planFacility(20n, 'S1_FACILITY_A')],
  });
  const fleet = { id: 'S1', name: 'S1 Emergency Fleet', trucks: 2, base: '' };

  it('truck status comes from approved plans at the sim clock', () => {
    expect(fleetTrucks(live, fleet).map((t) => t.status)).toEqual(['En route', 'Standby']);
    const hauling = liveData({ ...live, clock: { ...live.clock!, nowUnix: NOW + 100 * 60 } });
    expect(fleetTrucks(hauling, fleet)[0]?.status).toBe('Hauling');
    const back = liveData({ ...live, clock: { ...live.clock!, nowUnix: NOW + 400 * 60 } });
    expect(fleetTrucks(back, fleet)[0]?.status).toBe('Standby');
  });

  it('borrows from the nearest fleet that keeps a truck on standby', () => {
    const recs = temporaryRecommendations(liveData({ systems: [system('S1', 32, -102), system('S2', 32.1, -102), system('S3', 35, -100)] }), [
      { id: 'S1', trucks: 2, standby: 0, failures: 0 },
      { id: 'S2', trucks: 2, standby: 2, failures: 0 },
      { id: 'S3', trucks: 3, standby: 3, failures: 0 },
    ]);
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ from: 'S2', to: 'S1' });
    expect(temporaryRecommendations(liveData({ systems: S1 }), [{ id: 'S1', trucks: 2, standby: 1, failures: 0 }, { id: 'S2', trucks: 2, standby: 0, failures: 0 }])).toHaveLength(0);
  });

  it('long-term move uses the backend fleet sweep', () => {
    const rows = [sweep('S2', 1, 5568, false), sweep('S2', 2, 5175, true), sweep('S2', 3, 2715, false), sweep('S3', 2, 905, false), sweep('S3', 3, 905, true), sweep('S3', 4, 905, false)];
    expect(longTermRecommendation(liveData({ systems: S1 }), rows)).toMatchObject({ from: 'S3', to: 'S2' });
    const balanced = [sweep('S2', 1, 1000, false), sweep('S2', 2, 900, true), sweep('S2', 3, 900, false), sweep('S3', 1, 2000, false), sweep('S3', 2, 900, true), sweep('S3', 3, 900, false)];
    expect(longTermRecommendation(liveData({ systems: S1 }), balanced)).toBeNull();
  });
});

describe('timeline', () => {
  it('links recoveries and decisions to their events by id, newest first', () => {
    const live = liveData({
      events: [event('e1', 'S10_FACILITY_A', 'S10', 'pump_failure', { status: 'resolved', endUnix: NOW - 60 })],
      decisions: [decision(7n, 'e1', 'plan', { systemId: 'S10', asOfUnix: NOW - 3000 })],
    });
    const nodes = sortHistory([...historyNodes(live), ...decisionNodes(live)]);
    expect(nodes.map((n) => n.id)).toEqual(['e1:recovery', 'decision:7', 'e1']);
    expect(nodes.find((n) => n.id === 'e1:recovery')?.parentId).toBe('e1');
    expect(nodes.find((n) => n.id === 'decision:7')?.parentId).toBe('e1');
    // system comes from the backend, not from the first 2 characters of an id (S10 != S1)
    expect(nodes.every((n) => n.system === 'S10')).toBe(true);
  });
});

describe('network map', () => {
  it('grows the canvas with the network (6 systems) and fits the geo view to its coordinates', () => {
    const systems = ['S6', 'S7', 'S8', 'S9', 'S10', 'S11'].map((id, i) => system(id, 40 + i, -90 - i));
    const facilities = systems.map((_, i) => facility(`S${6 + i}_FACILITY_A`, `S${6 + i}`, { lat: 40 + i, lon: -90 - i }));
    const m = mapModel(liveData({ systems, facilities }));
    expect(m.boxes).toHaveLength(6);
    expect(Math.max(...m.boxes.map((b) => b.x + b.w))).toBeLessThanOrEqual(m.W);
    for (const n of m.geoNodes) {
      expect(n.x).toBeGreaterThanOrEqual(0);
      expect(n.x).toBeLessThanOrEqual(m.W);
      expect(n.y).toBeGreaterThanOrEqual(0);
      expect(n.y).toBeLessThanOrEqual(m.H);
    }
    expect(m.latTicks.length).toBeGreaterThan(0);
  });

  it('marks failing pumps and leaking pipelines from backend events', () => {
    const live = liveData({
      systems: [system('S1')],
      facilities: [facility('S1_FACILITY_A', 'S1')],
      facilityStates: [state('S1_FACILITY_A', 'S1', 88, 2400)],
      events: [event('f', 'S1_FACILITY_A', 'S1', 'pump_failure'), event('l', 'S1_FACILITY_A', 'S1', 'pipeline_leak')],
    });
    const m = mapModel(live);
    expect(m.nodes.find((n) => n.id === 'S1_PUMP_A')?.status).toBe('fail');
    expect(m.nodes.find((n) => n.id === 'S1_TANK_A')?.status).toBe('warn'); // 88% >= 85% warning
    expect(m.edges.find((e) => e.id === 'S1_PIPELINE_A')?.failing).toBe(true);
    expect(m.boxes[0]?.health).toBe('CRITICAL');
  });
});
