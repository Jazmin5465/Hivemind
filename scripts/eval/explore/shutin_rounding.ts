// Explore how the reference rounds shut-in start minutes: compute the continuous latest start
// from the labelled onset level (full_week, planned at onset). Eval-only.
import { loadFolder } from '../../../worker/src/folder';
import { readAnswerKey } from '../answerKey';
const d = loadFolder('data/eog/full_week');
const key = readAnswerKey('data/eog/full_week')!;
for (const e of key) {
  if (e.category !== 'pump_failure') continue;
  const ra = e.reference;
  if (!ra.wells?.length || ra.trucks) continue;
  const f = d.model.facilityById.get(e.facility)!;
  const C = f.capacityBbl, S = d.model.shutdownPct, L = e.levelPct!;
  const q = f.baselineInflowBpd / 24 / C * 100 / 60; // pct per minute
  const w = ra.wells.reduce((a, id) => a + d.model.wellById.get(id)!.baselineWaterBpd, 0) / 24 / C * 100 / 60;
  const T = d.model.repairHoursPumpFailure * 60;
  // L + q*s + (q-w)*(T-s) = S  -> s = (S - L - (q-w)*T)/w
  const s = (S - L - (q - w) * T) / w;
  const trip = (S - L) / q;
  console.log(e.id, 'L', L, 'ref start', ra.startAfterMin, 'continuous s*', s.toFixed(3), 'trip at', trip.toFixed(2), 'min', 'ref says before trip', e.referenceActionRaw.match(/~(\d+) min before/)?.[1]);
}
