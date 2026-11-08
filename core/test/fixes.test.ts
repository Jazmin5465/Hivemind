// Worker mapping of the ML sidecar's /fixes/all (docs/API_REFERENCE.md) onto backend events and popup options.
import { describe, expect, it } from 'vitest';
import { fixesToRows, fixOptionKey, type FixesAllResponse } from '../../worker/src/ml';

describe('/fixes labels -> console option keys', () => {
  it('maps every documented label', () => {
    expect(fixOptionKey('Recommended (cheapest for the whole system): Send 2 trucks to S4_FACILITY_C now for 1 trip each.')).toBe('optimal');
    expect(fixOptionKey('Trucks only: Send 1 truck ...')).toBe('trucks_only');
    expect(fixOptionKey('Shut in wells only: Shut in S4_WELL_C1 at 03:37 UTC (7 min from now) until the repair ends.')).toBe('shut_in_only');
    expect(fixOptionKey('Do nothing and let the tank trip; all wells shut in automatically until the repair ends.')).toBe('do_nothing');
    expect(fixOptionKey('No action needed: the tank stays below the limit')).toBe('none_needed');
    expect(fixOptionKey('Send an inspector to S5_PIPELINE_B now (pipeline leak).')).toBe('inspect');
    expect(fixOptionKey('No action yet: monitor S5_PIPELINE_B (pipeline leak).')).toBe('monitor');
  });
});

describe('/fixes events -> backend events', () => {
  const resp: FixesAllResponse = {
    asOfUnix: 100,
    events: [
      { eventId: 'pump_failure:S4_PUMP_C:1791511200', category: 'pump_failure', assetId: 'S4_PUMP_C', facilityId: 'S4_FACILITY_C', systemId: 'S4', onsetUnix: 1791511200, confidence: 1 },
      { eventId: 'pipeline_leak:S5_PIPELINE_B:1791439800', category: 'pipeline_leak', assetId: 'S5_PIPELINE_B', facilityId: 'S5_FACILITY_B', systemId: 'S5', onsetUnix: 1791439800, confidence: 1 },
      { eventId: 'pump_degradation:S3_PUMP_A:1', category: 'pump_degradation', assetId: 'S3_PUMP_A', facilityId: 'S3_FACILITY_A', systemId: 'S3', onsetUnix: 1, confidence: 1 },
    ],
    results: [
      { eventId: 'pump_failure:S4_PUMP_C:1791511200', fixes: [{ fixDescription: 'Recommended (cheapest for the whole system): x', predictedSequence: ['a'], cost: 1810, costReasoning: 'Total: $1,810.' }] },
      { eventId: 'pipeline_leak:S5_PIPELINE_B:1791439800', fixes: [{ fixDescription: 'Send an inspector to S5_PIPELINE_B now', predictedSequence: [], cost: 0, costReasoning: 'unpriced' }] },
      { eventId: 'pump_degradation:S3_PUMP_A:1', fixes: [{ fixDescription: 'Send an inspector to S3_PUMP_A now', predictedSequence: [], cost: 0, costReasoning: 'unpriced' }] },
    ],
  };
  const backend = [
    { eventId: 'ds:pump_failure:S4_PUMP_C:1791511200', category: 'pump_failure', assetId: 'S4_PUMP_C', status: 'ongoing' },
    { eventId: 'ds:pipeline_leak:S5_PIPELINE_B:1791439500', category: 'pipeline_leak', assetId: 'S5_PIPELINE_B', status: 'ongoing' }, // onset differs a little
  ];
  it('matches by exact id, else by category and asset; drops events the backend does not have', () => {
    const rows = fixesToRows(resp, 'ds', backend);
    expect(rows.map((r) => [r.eventId, r.optionKey, r.cost])).toEqual([
      ['ds:pump_failure:S4_PUMP_C:1791511200', 'optimal', 1810],
      ['ds:pipeline_leak:S5_PIPELINE_B:1791439500', 'inspect', 0],
    ]);
    expect(rows[0]).toMatchObject({ facilityId: 'S4_FACILITY_C', rank: 1, predictedSequence: ['a'], costReasoning: 'Total: $1,810.' });
  });
});
