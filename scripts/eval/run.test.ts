// Smoke test: the scoreboard with fake core implementations (so the "implemented" paths are exercised
// while core/ is still stubbed). Skipped when the datasets are not present.
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const DATA = resolve(__dirname, '../../data/eog');
const hasData = existsSync(join(DATA, 'full_week', 'answer_key.json'));

vi.mock('../../core/src/detector/rules', async () => {
  const { readAnswerKey } = await import('./answerKey');
  const { join } = await import('node:path');
  const { resolve } = await import('node:path');
  const labels = readAnswerKey(join(resolve(__dirname, '../../data/eog'), 'full_week')) ?? [];
  return {
    // fake: replays the full-week labels, 10 min late, plus one false alarm
    detectRules: (model: any, grid: any, opts: any = {}) => {
      const asOf = opts.asOfUnix ?? grid.t0 + (grid.n - 1) * grid.stepSec;
      const evs = labels
        .filter((l) => l.onsetUnix + 600 <= asOf)
        .map((l) => ({
          category: l.category,
          systemId: l.system,
          facilityId: l.facility,
          assetId: l.asset,
          onsetUnix: l.onsetUnix + 600,
          endUnix: l.endUnix != null && l.endUnix <= asOf ? l.endUnix : null,
          status: l.endUnix != null && l.endUnix <= asOf ? 'resolved' : 'ongoing',
          confidence: 0.9,
          source: 'rules',
          evidence: ['fake'],
        }));
      const f = model.facilities[0];
      evs.push({ category: 'pipeline_leak', systemId: f.systemId, facilityId: f.id, assetId: f.pipelineId, onsetUnix: grid.t0, endUnix: grid.t0 + 3600, status: 'resolved', confidence: 0.5, source: 'rules', evidence: ['fake FA'] });
      return evs;
    },
  };
});

vi.mock('../../core/src/countdown', async () => {
  const { tankLevelAt } = await import('./common');
  return {
    countdownAt: (model: any, grid: any, facilityId: string, asOfUnix: number) => {
      const f = model.facilityById.get(facilityId);
      const levelPct = tankLevelAt(model, grid, facilityId, asOfUnix) ?? 0;
      const rate = (f.baselineInflowBpd / 24 / f.capacityBbl) * 100;
      const h = (model.shutdownPct - levelPct) / rate;
      return { facilityId, asOfUnix, levelPct, inflowBpd: f.baselineInflowBpd, ratePctPerHour: rate, hoursToLimitP50: h, hoursToLimitP10: h, hoursToLimitP90: h, tripsAtUnix: asOfUnix + h * 3600, alreadyTripped: false };
    },
  };
});

vi.mock('../../core/src/planner', () => ({
  // fake: one truck, one trip per failure
  planSystem: (input: any) => {
    const { model, nowUnix } = input;
    const fleet = input.overrides?.fleetSize ?? model.systemById.get(input.systemId).fleetSize;
    const facilities = input.failures.map((fi: any) => {
      const f = model.facilityById.get(fi.facilityId);
      const useTruck = fleet > 0;
      return {
        eventId: fi.eventId,
        facilityId: fi.facilityId,
        actions: useTruck ? [{ type: 'dispatch_truck', facilityId: fi.facilityId, trucks: 1, tripsPerTruck: 1 }] : [{ type: 'none' }],
        cost: useTruck ? model.costPerTrip : 5000,
        doNothingCost: 5000,
        tripsAtUnixIfNothing: null,
        tripsAtUnix: null,
        peakLevelPct: 80,
        truckArrivalsUnix: [],
        truckFreeAtUnix: useTruck ? [nowUnix + (f.responseMin + f.cycleMin) * 60] : [],
        levelTrace: { t0: nowUnix, stepSec: 300, values: [] },
        summary: 'fake',
      };
    });
    const totalCost = facilities.reduce((a: number, f: any) => a + f.cost, 0);
    return { systemId: input.systemId, nowUnix, fleetSize: fleet, trucksAvailable: fleet, totalCost, doNothingCost: 5000, facilities, stats: { evaluated: 1, ms: 0 } };
  },
}));

describe.skipIf(!hasData)('eval scoreboard with fake core', () => {
  it('scores detection, countdowns and plans', async () => {
    const { main } = await import('./run');
    const res = main(['--data', DATA, '--sweep-min', '60', '--strict', ...(process.env.EVAL_VERBOSE ? ['--verbose'] : [])], process.env.EVAL_PRINT ? console.log : () => {});
    expect(res.text).toContain('full_week');
    expect(res.text).not.toContain('not implemented');
    expect(res.text).toMatch(/fail (\d+)\/\1 ✓/); // every full-week pump failure found
    expect(res.text).toMatch(/FA 1 ✗/); // the injected false alarm
    expect(res.summary.pass).toBeGreaterThan(50);
    expect(res.exitCode).toBe(1); // fake planner is worse than reference somewhere
  });
});
