// Rules detector tests: causality / prefix consistency on full_week (if present) and
// synthetic in-memory cases (no dependency on any labels).
import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { buildModel } from '../src/model';
import { seriesKey, truncateGrid, tsAt, type Grid } from '../src/telemetry';
import { detectRules } from '../src/detector/rules';
import type { DetectedEvent } from '../src/types';
import { loadFolder } from '../../worker/src/folder';

// ---------------------------------------------------------------------------------------
// Synthetic network + simulator
// ---------------------------------------------------------------------------------------

interface FacSpec {
  id: string;
  maxFlow: number;
  inflow: number;
  cap: number;
}

function makeModel(sysId: string, disposalPsi: number, facs: FacSpec[]) {
  const network = {
    defaults: { tank_limits_pct: { warning: 85, shutdown: 92 } },
    systems: [
      {
        id: sysId,
        center: [32, -102],
        truck_yard: [32.1, -102.1],
        disposal_site: { id: `${sysId}_DSP`, lat: 32, lon: -102, pressure_psi: disposalPsi },
        facilities: facs.map((f) => ({
          id: f.id,
          lat: 32,
          lon: -102,
          wells: [{ id: `${f.id}_W1`, baseline_water_bpd: f.inflow, oil_bpd: 100, gas_mcfd: 300 }],
          tank: { id: `${f.id}_T`, capacity_bbl: f.cap },
          pump: { id: `${f.id}_P`, max_flow_bpd: f.maxFlow, start_level_pct: 70, stop_level_pct: 30 },
          pipeline: { id: `${f.id}_L`, max_bpd: f.maxFlow * 1.2, max_pressure_psi: disposalPsi + 600 },
        })),
      },
    ],
  };
  const ops = {
    dataset_id: 'synthetic',
    prices: { oil_per_bbl: 70, gas_per_mcf: 3 },
    emergency_trucking: { truck_capacity_bbl: 150, cost_per_trip: 900 },
    expected_repair_hours: { pump_failure: 6 },
    systems: {
      [sysId]: { emergency_fleet_size: 2, facilities: Object.fromEntries(facs.map((f) => [f.id, { response_min: 60, cycle_min: 200 }])) },
    },
  };
  return buildModel(network, ops);
}

/** Deterministic PRNG + gaussian noise. */
function rng(seed: number) {
  let s = seed >>> 0;
  const u = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return (s + 0.5) / 4294967296;
  };
  return () => Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u());
}

interface Faults {
  /** [fromStep, toStep) the pump is in fault */
  fault?: [number, number];
  /** [fromStep, toStep) the pipeline leaks: receive drops `loss` and pressure `dropPsi` (while pumping) */
  leak?: [number, number];
  leakLoss?: number;
  leakDropPsi?: number;
  /** [fromStep, toStep) pump wears: flow loses `wearPerHour` of rated per hour of event */
  wear?: [number, number];
  wearPerHour?: number;
}

const T0 = 1_791_158_400; // 2026-10-05T00:00Z
const STEP = 300;
const HOUR = 12; // steps per hour

/** Physics knobs: SPEC calls the +50/+150 pressure offsets placeholders, so test others too. */
interface Phys {
  pipeOff: number;
  disOff: number;
  pNoise: number;
}
const DOC_PHYS: Phys = { pipeOff: 50, disOff: 150, pNoise: 3 };

function simulate(model: ReturnType<typeof makeModel>, n: number, faults: Record<string, Faults>, seed = 1, phys: Phys = DOC_PHYS): Grid {
  const g = rng(seed);
  const series = new Map<string, Float64Array>();
  const arr = (a: string, m: string) => {
    const x = new Float64Array(n);
    series.set(seriesKey(a, m), x);
    return x;
  };
  for (const f of model.facilities) {
    const disp = model.systemById.get(f.systemId)!.disposalPressurePsi;
    const fl = faults[f.id] ?? {};
    const st = arr(f.pumpId, 'status');
    const flow = arr(f.pumpId, 'flow_bpd');
    const dis = arr(f.pumpId, 'discharge_psi');
    const recv = arr(f.pipelineId, 'receive_flow_bpd');
    const pp = arr(f.pipelineId, 'pressure_psi');
    const lvl = arr(f.tankId, 'level_pct');
    const inflow = arr(f.id, 'inflow_bpd');
    let level = 45;
    let running = false;
    const inRange = (r: [number, number] | undefined, i: number) => !!r && i >= r[0] && i < r[1];
    for (let i = 0; i < n; i++) {
      const fault = inRange(fl.fault, i);
      if (!fault) {
        if (level >= f.startLevelPct) running = true;
        if (level <= f.stopLevelPct) running = false;
      }
      const shut = level >= model.shutdownPct && fault;
      const q = shut ? 0 : f.baselineInflowBpd * (1 + 0.003 * g());
      let wear = 0;
      if (inRange(fl.wear, i)) wear = ((fl.wearPerHour ?? 0.004) * (i - fl.wear![0])) / HOUR;
      const pumping = running && !fault;
      const out = pumping ? f.maxFlowBpd * (1 - wear) * (1 + 0.006 * g()) : 0;
      const leaking = pumping && inRange(fl.leak, i);
      st[i] = fault ? 2 : pumping ? 1 : 0;
      flow[i] = out;
      dis[i] = disp + (pumping ? phys.disOff - 400 * wear : 0) + phys.pNoise * g();
      recv[i] = pumping ? out * (1 - (leaking ? (fl.leakLoss ?? 0.025) : 0)) * (1 + 0.006 * g()) : 0;
      pp[i] = disp + (pumping ? phys.pipeOff - (leaking ? (fl.leakDropPsi ?? 18) : 0) : 0) + phys.pNoise * g();
      inflow[i] = q;
      lvl[i] = level;
      level = Math.min(model.shutdownPct, Math.max(0, level + ((q - out) / 24 / f.capacityBbl) * 100 / HOUR));
    }
  }
  return { t0: T0, stepSec: STEP, n, series };
}

const at = (i: number) => T0 + i * STEP;
const find = (evs: DetectedEvent[], cat: string, asset: string) => evs.filter((e) => e.category === cat && e.assetId === asset);

// ---------------------------------------------------------------------------------------
// Synthetic cases
// ---------------------------------------------------------------------------------------

describe('detectRules on synthetic data', () => {
  const facs: FacSpec[] = [
    { id: 'Q1_A', maxFlow: 3000, inflow: 2000, cap: 900 },
    { id: 'Q1_B', maxFlow: 2400, inflow: 1500, cap: 700 },
    { id: 'Q1_C', maxFlow: 5200, inflow: 3600, cap: 1500 },
    { id: 'Q1_D', maxFlow: 1800, inflow: 1100, cap: 600 },
  ];
  const N = 3 * 24 * HOUR; // three days

  it('healthy network: no events (several seeds, unusual sizes and pressures)', () => {
    for (const [seed, disp] of [[1, 1050], [2, 640], [3, 2300]] as const) {
      const model = makeModel('Q1', disp, facs);
      const grid = simulate(model, N, {}, seed);
      expect(detectRules(model, grid)).toEqual([]);
    }
  });

  it('self-calibrates when pressure offsets / noise differ from the documented placeholders', () => {
    for (const phys of [
      { pipeOff: 35, disOff: 110, pNoise: 3 },
      { pipeOff: 80, disOff: 240, pNoise: 6 },
    ]) {
      const model = makeModel('Q1', 1300, facs);
      expect(detectRules(model, simulate(model, N, {}, 5, phys))).toEqual([]);
      const leak: [number, number] = [400, 400 + 12 * HOUR];
      const grid = simulate(model, N, { Q1_D: { leak, leakDropPsi: phys.pipeOff * 0.35 } }, 6, phys);
      const evs = detectRules(model, grid);
      expect(evs.map((e) => `${e.category}:${e.assetId}`)).toEqual(['pipeline_leak:Q1_D_L']);
    }
  });

  it('pump_failure: exact onset/end from fault status, ongoing while in fault', () => {
    const model = makeModel('Q1', 1500, facs);
    const grid = simulate(model, N, { Q1_A: { fault: [400, 472] } });
    const evs = find(detectRules(model, grid), 'pump_failure', 'Q1_A_P');
    expect(evs).toHaveLength(1);
    expect(evs[0].onsetUnix).toBe(at(400));
    expect(evs[0].endUnix).toBe(at(472));
    expect(evs[0].status).toBe('resolved');
    expect(evs[0].confidence).toBeGreaterThan(0.95);
    const mid = find(detectRules(model, grid, { asOfUnix: at(430) }), 'pump_failure', 'Q1_A_P');
    expect(mid[0]).toMatchObject({ status: 'ongoing', endUnix: null, onsetUnix: at(400) });
    expect(mid[0].evidence[0]).toMatch(/fault since/);
  });

  it('pipeline_leak: detected fast, survives pump-off periods, ends after repair', () => {
    const model = makeModel('Q1', 900, facs);
    const leak: [number, number] = [300, 300 + 20 * HOUR];
    const grid = simulate(model, N, { Q1_B: { leak } });
    const evs = find(detectRules(model, grid), 'pipeline_leak', 'Q1_B_L');
    expect(evs).toHaveLength(1); // one event despite the sawtooth pump cycle
    const e = evs[0];
    // onset is the first pumping step inside the leak window (leak invisible while stopped)
    const st = grid.series.get(seriesKey('Q1_B_P', 'status'))!;
    let firstPumping = leak[0];
    while (st[firstPumping] !== 1) firstPumping++;
    expect(Math.abs(e.onsetUnix - at(firstPumping))).toBeLessThanOrEqual(2 * STEP);
    expect(e.status).toBe('resolved');
    expect(e.endUnix!).toBeGreaterThanOrEqual(at(leak[1]));
    expect(e.evidence[0]).toMatch(/disposal site is 9\d\.\d% of what the pump sends/);
    expect(e.evidence[1]).toMatch(/Pipeline pressure \d+ psi below normal/);
    // no degradation / failure confusion on that facility
    expect(detectRules(model, grid).filter((x) => x.facilityId === 'Q1_B')).toHaveLength(1);
  });

  it('pump_degradation: detected within a few hours, ends where a later failure starts', () => {
    const model = makeModel('Q1', 1200, facs);
    const wear: [number, number] = [200, 200 + 30 * HOUR];
    const grid = simulate(model, N, { Q1_C: { wear, fault: [wear[1], wear[1] + 6 * HOUR] } });
    const all = detectRules(model, grid);
    const deg = find(all, 'pump_degradation', 'Q1_C_P');
    const fail = find(all, 'pump_failure', 'Q1_C_P');
    expect(deg).toHaveLength(1);
    expect(fail).toHaveLength(1);
    expect(Math.abs(deg[0].onsetUnix - at(wear[0]))).toBeLessThanOrEqual(3 * 3600);
    expect(deg[0].endUnix).toBe(fail[0].onsetUnix);
    expect(deg[0].evidence[0]).toMatch(/Pump moving \d+\.\d% of its rated 5,200 bpd/);
    // early on, confidence is honest (lower), and it grows with evidence
    let firstSeen: DetectedEvent | undefined;
    for (let i = wear[0]; i < wear[1] && !firstSeen; i += 3) {
      firstSeen = find(detectRules(model, grid, { asOfUnix: at(i) }), 'pump_degradation', 'Q1_C_P')[0];
    }
    expect(firstSeen).toBeDefined();
    expect(firstSeen!.onsetUnix - at(wear[0])).toBeLessThan(6 * 3600);
    const later = find(detectRules(model, grid, { asOfUnix: at(wear[1] - 1) }), 'pump_degradation', 'Q1_C_P')[0];
    expect(later.confidence).toBeGreaterThan(firstSeen!.confidence);
    expect(later.onsetUnix).toBe(firstSeen!.onsetUnix);
  });

  it('is causal and prefix-consistent on synthetic data', () => {
    const model = makeModel('Q1', 1000, facs);
    const grid = simulate(model, N, {
      Q1_A: { fault: [500, 572] },
      Q1_B: { leak: [100, 400] },
      Q1_C: { wear: [250, 700] },
    });
    checkPrefixConsistency(model, grid, 7);
  });
});

// ---------------------------------------------------------------------------------------
// Prefix consistency helper (used on synthetic data and on full_week)
// ---------------------------------------------------------------------------------------

function checkPrefixConsistency(model: ReturnType<typeof buildModel>, grid: Grid, everySteps: number) {
  const full = detectRules(model, grid);
  const k = (e: DetectedEvent) => `${e.category}|${e.assetId}|${e.onsetUnix}`;
  const fullByKey = new Map(full.map((e) => [k(e), e]));
  for (let i = 0; i < grid.n; i += everySteps) {
    const T = tsAt(grid, i);
    const atT = detectRules(model, grid, { asOfUnix: T });
    // physically truncated grid gives the identical answer (no peeking past T)
    expect(detectRules(model, truncateGrid(grid, T))).toEqual(atT);
    for (const e of atT) {
      expect(e.onsetUnix).toBeLessThanOrEqual(T);
      const f = fullByKey.get(k(e));
      expect(f, `event ${k(e)} at T=${T} missing from full run`).toBeDefined();
      if (e.status === 'resolved') {
        expect(e.endUnix).not.toBeNull();
        expect(e.endUnix!).toBeLessThanOrEqual(T);
        expect(f!.endUnix).toBe(e.endUnix);
      } else {
        expect(e.endUnix).toBeNull();
      }
      expect(e.confidence).toBeGreaterThanOrEqual(0);
      expect(e.confidence).toBeLessThanOrEqual(1);
      expect(e.evidence.length).toBeGreaterThanOrEqual(1);
      expect(e.evidence.length).toBeLessThanOrEqual(3);
    }
  }
  // garbage after T must not change the result at T
  const T = tsAt(grid, Math.floor(grid.n / 2));
  const poisoned: Grid = { ...grid, series: new Map() };
  const cut = Math.floor(grid.n / 2) + 1;
  for (const [key, a] of grid.series) {
    const b = a.slice();
    for (let j = cut; j < b.length; j++) b[j] = key.endsWith('|status') ? 2 : -1e6;
    poisoned.series.set(key, b);
  }
  expect(detectRules(model, poisoned, { asOfUnix: T })).toEqual(detectRules(model, grid, { asOfUnix: T }));
}

const FULL_WEEK = '/Users/suhan/HackUTD26/Hivemind/data/eog/full_week';
describe.skipIf(!existsSync(FULL_WEEK))('detectRules on full_week', () => {
  const { model, grid } = loadFolder(FULL_WEEK);

  it('is causal and prefix-consistent at many cut points', () => {
    checkPrefixConsistency(model, grid, 13); // ~every hour, at varied phases
  });

  it('runs a full week well under 300 ms', () => {
    detectRules(model, grid); // warm-up (JIT)
    const t = performance.now();
    detectRules(model, grid);
    expect(performance.now() - t).toBeLessThan(300);
  });
});
