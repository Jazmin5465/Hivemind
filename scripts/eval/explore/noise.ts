// Exploration: per-step noise of normalised readings outside labelled events (full_week).
// Usage: npx tsx scripts/eval/explore/noise.ts <folder>
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadFolder } from '../../../worker/src/folder';
import { gridGet, tsAt } from '../../../core/src/telemetry';

const dir = process.argv[2];
const { model, grid } = loadFolder(dir);
const key = JSON.parse(readFileSync(join(dir, 'answer_key.json'), 'utf8')) as any[];

function stats(xs: number[]) {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
  const s = [...xs].sort((a, b) => a - b);
  return `n=${xs.length} mean=${m.toFixed(4)} sd=${sd.toFixed(4)} min=${s[0].toFixed(4)} p1=${s[Math.floor(s.length * 0.01)].toFixed(4)} p99=${s[Math.floor(s.length * 0.99)].toFixed(4)} max=${s[s.length - 1].toFixed(4)}`;
}
const all: Record<string, number[]> = { flow: [], recv: [], pp: [], dp: [], ppOff: [], dpOff: [], flowFirst: [], dpFirst: [], ppFirst: [], recvFirst: [], dpLast: [] };
for (const f of model.facilities) {
  const disp = model.systemById.get(f.systemId)!.disposalPressurePsi;
  const evs = key.filter((e) => e.facility === f.id);
  const inEvent = (t: number) => evs.some((e) => t >= e.onset_unix - 3600 && t < e.end_unix + 6 * 3600);
  const st = gridGet(grid, f.pumpId, 'status')!;
  const fl = gridGet(grid, f.pumpId, 'flow_bpd')!;
  const dp = gridGet(grid, f.pumpId, 'discharge_psi')!;
  const rf = gridGet(grid, f.pipelineId, 'receive_flow_bpd')!;
  const pp = gridGet(grid, f.pipelineId, 'pressure_psi')!;
  for (let i = 1; i < grid.n; i++) {
    if (inEvent(tsAt(grid, i))) continue;
    if (st[i] === 1) {
      all.flow.push(fl[i] / f.maxFlowBpd);
      all.recv.push(rf[i] / fl[i]);
      all.pp.push(pp[i] - disp - 50);
      all.dp.push(dp[i] - disp - 150);
      if (st[i - 1] !== 1) {
        all.flowFirst.push(fl[i] / f.maxFlowBpd);
        all.dpFirst.push(dp[i] - disp - 150);
        all.ppFirst.push(pp[i] - disp - 50);
        all.recvFirst.push(rf[i] / fl[i]);
      }
    } else if (st[i] === 0) {
      all.ppOff.push(pp[i] - disp);
      all.dpOff.push(dp[i] - disp);
      if (st[i - 1] === 1) all.dpLast.push(dp[i] - disp);
    }
  }
}
for (const [k, v] of Object.entries(all)) console.log(k.padEnd(10), stats(v));
// statuses seen
const vals = new Set<number>();
for (const f of model.facilities) for (const v of gridGet(grid, f.pumpId, 'status')!) vals.add(v);
console.log('pump status values', [...vals]);
