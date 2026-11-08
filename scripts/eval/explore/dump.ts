// Exploration: hourly summaries of a facility's pump/pipeline readings, normalised.
// Usage: npx tsx scripts/eval/explore/dump.ts <folder> <facilityId> [fromIso] [toIso]
import { loadFolder } from '../../../worker/src/folder';
import { gridGet, tsAt } from '../../../core/src/telemetry';

const [dir, facId, fromIso, toIso] = process.argv.slice(2);
const { model, grid } = loadFolder(dir);
const f = model.facilityById.get(facId)!;
const sys = model.systemById.get(f.systemId)!;
const disp = sys.disposalPressurePsi;
const st = gridGet(grid, f.pumpId, 'status')!;
const fl = gridGet(grid, f.pumpId, 'flow_bpd')!;
const dp = gridGet(grid, f.pumpId, 'discharge_psi')!;
const rf = gridGet(grid, f.pipelineId, 'receive_flow_bpd')!;
const pp = gridGet(grid, f.pipelineId, 'pressure_psi')!;
const lv = gridGet(grid, f.tankId, 'level_pct')!;
const inf = gridGet(grid, f.id, 'inflow_bpd')!;
const from = fromIso ? Date.parse(fromIso) / 1000 : grid.t0;
const to = toIso ? Date.parse(toIso) / 1000 : tsAt(grid, grid.n - 1);
console.log(`${facId} max=${f.maxFlowBpd} disp=${disp} cap=${f.capacityBbl} start=${f.startLevelPct} stop=${f.stopLevelPct} baseIn=${f.baselineInflowBpd}`);
const per = 12;
for (let h = 0; h < grid.n; h += per) {
  const t = tsAt(grid, h);
  if (t < from || t > to) continue;
  let nRun = 0, sF = 0, sR = 0, sP = 0, sD = 0, nOff = 0, sPo = 0, sDo = 0, nFault = 0;
  for (let i = h; i < Math.min(grid.n, h + per); i++) {
    if (st[i] === 1) { nRun++; sF += fl[i] / f.maxFlowBpd; sR += rf[i] / fl[i]; sP += pp[i] - disp; sD += dp[i] - disp; }
    else if (st[i] === 2) nFault++;
    else { nOff++; sPo += pp[i] - disp; sDo += dp[i] - disp; }
  }
  const r = (x: number, n: number) => (n ? (x / n).toFixed(3) : '  -  ');
  console.log(
    new Date(t * 1000).toISOString().slice(5, 16),
    `run=${String(nRun).padStart(2)} fault=${String(nFault).padStart(2)} flow/max=${r(sF, nRun)} recv/flow=${r(sR, nRun)} pp-d=${r(sP, nRun)} dp-d=${r(sD, nRun)} | off pp-d=${r(sPo, nOff)} dp-d=${r(sDo, nOff)} lvl=${lv[h].toFixed(1)} in=${inf[h].toFixed(0)}`,
  );
}
