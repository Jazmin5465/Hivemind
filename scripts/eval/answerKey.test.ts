import { describe, expect, it } from 'vitest';
import { parseAnswerKey, parseReferenceAction as p } from './answerKey';

describe('parseReferenceAction', () => {
  it('parses truck plans', () => {
    expect(p('1 truck, 1 trip (~$905)')).toMatchObject({ kind: 'truck', cost: 905, trucks: 1, tripsPerTruck: 1, totalTrips: 1 });
    expect(p('2 trucks, 1 trip each (~$1,810)')).toMatchObject({ kind: 'truck', cost: 1810, trucks: 2, tripsPerTruck: 1, totalTrips: 2 });
    expect(p('1 truck, 2 trips (~$1,810)')).toMatchObject({ kind: 'truck', cost: 1810, trucks: 1, tripsPerTruck: 2, totalTrips: 2 });
  });

  it('parses shut-ins, mixed plans and notes', () => {
    const s = p("shut in S2_WELL_C1 at +46 min, ~94 min before the trip (~$1,298) (shares S2's 2 trucks with EVENT_11, EVENT_13)");
    expect(s).toMatchObject({ kind: 'shut_in', cost: 1298, wells: ['S2_WELL_C1'], startAfterMin: 46, fleetSize: 2, trucks: 0 });
    expect(s.sharesWith).toEqual(['EVENT_11', 'EVENT_13']);

    const m = p('1 truck, 1 trip + shut in S4_WELL_A2 at +291 min (~$975)');
    expect(m).toMatchObject({ kind: 'truck+shut_in', cost: 975, trucks: 1, tripsPerTruck: 1, wells: ['S4_WELL_A2'], startAfterMin: 291 });

    const f = p('1 truck, 1 trip (~$905) (1 of 2 trucks free; the rest are on earlier events)');
    expect(f).toMatchObject({ kind: 'truck', cost: 905, trucksFree: 1, fleetSize: 2 });

    expect(p('shut in X_WELL_1, X_WELL_2 and X_WELL_3 at +0 min (~$10)').wells).toEqual(['X_WELL_1', 'X_WELL_2', 'X_WELL_3']);
  });

  it('parses none / inspection / unknown', () => {
    expect(p('none (peaks ~76.7%, never trips)')).toMatchObject({ kind: 'none', cost: 0, notes: ['peaks ~76.7%, never trips'] });
    expect(p('field_inspection')).toMatchObject({ kind: 'field_inspection', cost: 0 });
    const u = p('call the governor');
    expect(u.kind).toBe('unknown');
    expect(u.raw).toBe('call the governor');
  });
});

describe('parseAnswerKey', () => {
  it('accepts arrays and {events}, sorts by onset', () => {
    const ev = (id: string, t: number) => ({ id, system: 'S', facility: 'F', asset: 'A', category: 'pipeline_leak', onset_unix: t, end_unix: null, status: 'ongoing', reference_action: 'field_inspection' });
    expect(parseAnswerKey(JSON.stringify([ev('b', 2), ev('a', 1)])).map((e) => e.id)).toEqual(['a', 'b']);
    expect(parseAnswerKey(JSON.stringify({ events: [ev('x', 5)] }))[0]).toMatchObject({ id: 'x', endUnix: null, reference: { kind: 'field_inspection' } });
  });
});
