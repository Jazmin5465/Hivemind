import { describe, expect, it } from 'vitest';
import {
  decisionNodes, dedupeOptions, effectiveNow, fixFor, fleetTrucks, historyNodes, mapModel, optionPlans, pendingPriority, planToOption, priorityQueue,
  recommendations, sortHistory, tickSeconds, watchItems,
} from '@/lib/live/derive';
import { action, decision, event, facility, identity, liveData, NOW, plan, planFacility, state, system, ts } from './live-fixtures';

const S1 = [system('S1', 32, -102), system('S2', 32.2, -101.8)];
const facs = [facility('S1_FACILITY_A', 'S1'), facility('S1_FACILITY_B', 'S1'), facility('S2_FACILITY_A', 'S2')];

describe('priority queue (live)', () => {
  const live = liveData({
    systems: S1,
    facilities: facs,
    facilityStates: [
      state('S1_FACILITY_A', 'S1', 70, 2400),
      state('S1_FACILITY_B', 'S1', 50, 2400, { watchRank: 2, watchHours: 5.04 }),
      state('S2_FACILITY_A', 'S2', 80, 1200, { watchRank: 1, watchHours: 2.88 }),
    ],
    events: [
      event('e-leak', 'S2_FACILITY_A', 'S2', 'pipeline_leak', { alertRank: 2 }),
      event('e-fail', 'S1_FACILITY_A', 'S1', 'pump_failure', { alertRank: 1, hoursToLimitP50: 1.5 }),
      event('e-old', 'S1_FACILITY_B', 'S1', 'pump_degradation', { status: 'resolved', alertRank: 0 }),
    ],
  });

  it('shows ongoing alerts in the backend alertRank order, then the backend proactive-watch list', () => {
    const q = priorityQueue(live);
    expect(q.map((i) => i.id)).toEqual(['e-fail', 'e-leak', 'watch:S2_FACILITY_A', 'watch:S1_FACILITY_B']);
    expect(q[0]?.seconds).toBe(1.5 * 3600); // backend countdown, unchanged
    expect(q.some((i) => i.id === 'e-old')).toBe(false); // resolved events never queue
  });

  it('watch items are exactly the backend watch ranks and hours', () => {
    expect(watchItems(live).map((w) => [w.facility, w.seconds])).toEqual([['S2_FACILITY_A', 2.88 * 3600], ['S1_FACILITY_B', 5.04 * 3600]]);
  });

  it('hides items with an active decision (alerts by event, watch items by contingency)', () => {
    const q = priorityQueue(live);
    const pending = pendingPriority(q, [
      decision(1n, 'e-fail', 'plan'),
      decision(2n, '', 'contingency', { facilityId: 'S2_FACILITY_A' }),
      decision(3n, 'e-leak', 'inspection', { status: 'revoked' }),
    ]);
    expect(pending.map((i) => i.id)).toEqual(['e-leak', 'watch:S1_FACILITY_B']); // revoked decisions don't count
  });
});

describe('real-time countdown', () => {
  it('ticks 1 s per second from the backend value while the backend clock is paused', () => {
    const received = 1_000_000;
    const live = liveData({ clockReceivedAtMs: received });
    expect(effectiveNow(live, received)).toBe(NOW);
    expect(effectiveNow(live, received + 90_000)).toBe(NOW + 90);
    expect(tickSeconds(live, 3600, effectiveNow(live, received + 90_000))).toBe(3510);
    expect(tickSeconds(live, 60, NOW + 600)).toBe(0); // never negative
  });

  it('follows the backend clock as is while it is playing', () => {
    const live = liveData({ clockReceivedAtMs: 0 });
    const playing = liveData({ ...live, clock: { ...live.clock!, playing: true } });
    expect(effectiveNow(playing, 99_000_000)).toBe(NOW);
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
    planFacilities: [
      planFacility(10n, 'S1_FACILITY_A', { latestDispatchUnix: NOW + 193 * 60 }),
      planFacility(12n, 'S1_FACILITY_A', { cost: 1958, truckCost: 0, shutInCost: 1958, truckArrivalsUnix: [] }),
      planFacility(11n, 'S1_FACILITY_A', { cost: 5000, truckCost: 0, tripCost: 5000, tripsAtUnix: NOW + 3600, truckArrivalsUnix: [] }),
    ],
  });

  it("uses only this operator's newest batch, in a fixed order", () => {
    expect(optionPlans(live, 'S1', '').map((p) => p.planId)).toEqual([10n, 12n, 11n]);
  });

  it('turns backend plans into the popup cards with backend costs and the latest call time', () => {
    const [opt, shut, nothing] = optionPlans(live, 'S1', '').map((p) => planToOption(live, p));
    expect(opt).toMatchObject({ label: 'Send trucks', cost: 905, truckingCost: 905, trips: 1, shutdownHours: null, latestDispatchUnix: NOW + 193 * 60, firstArrivalUnix: NOW + 75 * 60 });
    expect(shut).toMatchObject({ label: 'Shut in selected wells', cost: 1958, wellIds: ['S1_WELL_A2'], latestDispatchUnix: undefined });
    expect(nothing).toMatchObject({ label: 'Do nothing', cost: 5000, revenueLoss: 5000, shutdownHours: 1 });
  });
});

describe('cost reasoning from the ML sidecar /fixes', () => {
  const fix = (eventId: string, rank: number, optionKey: string, costReasoning: string) => ({ key: eventId + '/' + rank, datasetId: 'fixture', eventId, facilityId: 'A', rank, optionKey, description: '', predictedSequence: [], cost: 905, costReasoning, asOfUnix: NOW }) as never;
  const live = liveData({ fixes: [fix('e1', 1, 'optimal', '1 truck x 1 trip x $905 = $905. Total: $905.'), fix('e1', 2, 'do_nothing', 'Automatic shut-in ... Total: $5,016.'), fix('e2', 1, 'none_needed', 'No action needed')] });
  it('matches the fix for an event and option', () => {
    expect(fixFor(live, 'e1', 'optimal')?.costReasoning).toMatch(/Total: \$905/);
    expect(fixFor(live, 'e1', 'do_nothing')?.costReasoning).toMatch(/5,016/);
    expect(fixFor(live, 'e1', 'trucks_only')).toBeUndefined();
    expect(fixFor(live, undefined, 'optimal')).toBeUndefined();
  });
  it('a tank that needs no action explains it on the recommended option', () => {
    expect(fixFor(live, 'e2', 'optimal')?.costReasoning).toBe('No action needed');
  });
});

describe('duplicate options', () => {
  it('hides an option identical to an earlier one (optimal == trucks only)', () => {
    const o = (key: string, cost: number, summary: string) => ({ key, label: '', cost, truckingCost: 0, revenueLoss: 0, trips: 0, trucks: 0, wellIds: [], shutdownHours: null, lines: [{ facilityId: 'A', summary }], valid: true, errors: [] }) as never;
    expect(dedupeOptions([o('optimal', 1810, '1 truck, 2 trips'), o('shut_in_only', 8966, 'shut in W1'), o('trucks_only', 1810, '1 truck, 2 trips')]).map((x: { key: string }) => x.key)).toEqual(['optimal', 'shut_in_only']);
  });
});

describe('fleets', () => {
  const live = liveData({
    systems: S1,
    opsSystems: [{ key: 'k', datasetId: 'fixture', systemId: 'S1', fleetSize: 2 } as never],
    plans: [plan(20n, 'S1', { status: 'approved', origin: 'planner' })],
    planActions: [action(20n, 'S1_FACILITY_A', 'dispatch_truck', { trucks: 1, tripsPerTruck: 1 })],
    planFacilities: [planFacility(20n, 'S1_FACILITY_A')], // dispatched NOW, arrives +75 min, free +305 min
  });
  const fleet = { id: 'S1', name: 'S1 Emergency Fleet', trucks: 2, base: '' };

  it('truck progress covers the whole job, with the arrival marked on the bar', () => {
    const [t0, idle] = fleetTrucks(live, fleet);
    expect(t0).toMatchObject({ status: 'En route', progress: 0, dispatch: NOW });
    expect(t0?.arrivalAt).toBeCloseTo(75 / 305, 5);
    expect(idle?.status).toBe('Standby');
    const mid = fleetTrucks(live, fleet, NOW + 100 * 60)[0];
    expect(mid?.status).toBe('Hauling');
    expect(mid?.progress).toBeCloseTo(100 / 305, 5);
    expect(fleetTrucks(live, fleet, NOW + 400 * 60)[0]?.status).toBe('Standby'); // back at the yard
  });

  it('fleet advice is the backend fleet_recommendation rows', () => {
    const recs = recommendations(
      liveData({
        fleetRecommendations: [
          { key: 'a', datasetId: 'fixture', kind: 'long_term', fromSystem: 'S1', toSystem: 'S2', km: 113, reason: 'r1', savings: 2479, asOfUnix: NOW } as never,
          { key: 'b', datasetId: 'fixture', kind: 'temporary', fromSystem: 'S4', toSystem: 'S2', km: 40, reason: 'r2', savings: 0, asOfUnix: NOW } as never,
        ],
      }),
    );
    expect(recs).toEqual([
      { kind: 'long_term', from: 'S1', to: 'S2', km: 113, reason: 'r1' },
      { kind: 'temporary', from: 'S4', to: 'S2', km: 40, reason: 'r2' },
    ]);
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
