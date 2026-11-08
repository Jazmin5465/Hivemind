// Hivemind eval harness: one-screen scoreboard over every dataset folder under --data.
//   npm run eval -- [--data <dir>] [--json <file>] [--strict] [--verbose] [--only <substr>]
//                   [--tol-min 60] [--sweep-min 30] [--busy ours|ref]
//                   [--level-tol 1.0] [--hours-tol 0.1] [--cost-tol 1]
// Core functions that are still stubs show "N/A (not implemented)" instead of crashing.
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadFolder, DATASET_FILES, type LoadedFolder } from '../../worker/src/folder';
import { detectRules } from '../../core/src/detector/rules';
import type { DetectedEvent, PlanAction } from '../../core/src/types';
import { readAnswerKey, type AnswerKeyEvent, type ReferenceAction } from './answerKey';
import { attempt, Checks, fmtMin, fmtNum, fmtTime, fmtUsd, gridNow, lpad, mark, naText, pad, type Attempt } from './common';
import { scoreDetection, type DetectionScore } from './detection';
import { scoreSnapshotDetected, scoreSnapshotOracle, type SnapshotModeResult, type Tolerances } from './snapshot';
import { replayFullWeek, type BusySource, type ReplayResult } from './replay';

// ---------- args ----------
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
interface Args {
  data: string;
  json: string | null;
  strict: boolean;
  verbose: boolean;
  only: string | null;
  tolMin: number;
  sweepMin: number;
  busy: BusySource;
  tol: Tolerances;
}
function parseArgs(argv: string[]): Args {
  const a: Args = {
    data: join(REPO, 'data', 'eog'),
    json: null,
    strict: false,
    verbose: false,
    only: null,
    tolMin: 60,
    sweepMin: 30,
    busy: 'ours',
    tol: { levelPct: 1.0, hours: 0.1, costUsd: 1 },
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = () => {
      const x = argv[++i];
      if (x == null) throw new Error(`${k} needs a value`);
      return x;
    };
    if (k === '--data') a.data = resolve(v());
    else if (k === '--json') a.json = resolve(v());
    else if (k === '--strict') a.strict = true;
    else if (k === '--verbose' || k === '-v') a.verbose = true;
    else if (k === '--only') a.only = v();
    else if (k === '--tol-min') a.tolMin = Number(v());
    else if (k === '--sweep-min') a.sweepMin = Number(v());
    else if (k === '--busy') a.busy = v() === 'ref' ? 'ref' : 'ours';
    else if (k === '--level-tol') a.tol.levelPct = Number(v());
    else if (k === '--hours-tol') a.tol.hours = Number(v());
    else if (k === '--cost-tol') a.tol.costUsd = Number(v());
    else if (k === '--help' || k === '-h') {
      console.log(readHelp());
      process.exit(0);
    } else throw new Error(`unknown argument ${k} (try --help)`);
  }
  return a;
}
function readHelp() {
  return `usage: npm run eval -- [--data <dir>] [--json <file>] [--strict] [--verbose] [--only <substr>]
  --tol-min N     detected onset may precede the label by N minutes (default 60)
  --sweep-min N   asOf sweep step for first-detected latency in fully-resolved folders (0 = off, default 30)
  --busy ours|ref replay: trucks busy from our earlier plans (default) or from the reference plans
  --level-tol / --hours-tol / --cost-tol   countdown and cost tolerances (1.0 pct, 0.1 h, $1)
  --strict        exit 1 if any check fails (N/A checks do not fail)`;
}

// ---------- formatting ----------
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
function fmtActions(actions: PlanAction[] | null | undefined): string {
  if (!actions || !actions.length) return 'none';
  return actions
    .map((x) => {
      if (x.type === 'dispatch_truck') {
        const t = x.trucks ?? 1;
        const tr = x.tripsPerTruck ?? 1;
        return `${plural(t, 'truck')}, ${plural(tr, 'trip')}${t > 1 ? ' each' : ''}`;
      }
      if (x.type === 'shut_in_wells') return `shut in ${(x.wells ?? []).join(', ')} at +${Math.round(x.startAfterMin ?? 0)} min`;
      if (x.type === 'field_inspection') return 'field_inspection';
      return 'none';
    })
    .join(' + ');
}
/** reference text without its parentheticals and trailing "~N min before the trip" */
function refShort(r: ReferenceAction): string {
  return r.raw.replace(/\([^()]*\)/g, '').replace(/,\s*~\s*\d+\s*min before the trip/i, '').replace(/\s+/g, ' ').trim();
}
const catShort: Record<string, string> = { pipeline_leak: 'leak', pump_degradation: 'degr', pump_failure: 'fail' };
const W = 100;
const rule = (title: string) => `━━ ${title} ${'━'.repeat(Math.max(3, W - title.length - 4))}`;
const costCell = (ours: number | null | undefined, ref: number | null | undefined, pass: boolean | null, better: boolean) =>
  `${lpad(fmtUsd(ours), 7)} vs ${lpad(fmtUsd(ref), 7)} ${mark(pass)}${better ? ' better than reference?' : ''}`;

// ---------- main ----------
interface FolderReport {
  folder: string;
  dir: string;
  nowUnix: number | null;
  labelled: boolean;
  load?: string;
  detection?: Attempt<DetectionScore>;
  replay?: ReplayResult;
  oracle?: SnapshotModeResult;
  detected?: SnapshotModeResult;
  unlabelledDetections?: Attempt<DetectedEvent[]>;
}

function discoverFolders(root: string): string[] {
  if (!existsSync(root)) throw new Error(`data root not found: ${root}`);
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && DATASET_FILES.every((f) => existsSync(join(root, d.name, f))))
    .map((d) => d.name)
    .sort();
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const checks = new Checks();
  const out: string[] = [];
  const say = (s = '') => out.push(s);
  const verbose = (s: string) => args.verbose && out.push(s);
  const mo = { tolSec: args.tolMin * 60 };

  const folders = discoverFolders(args.data).filter((f) => !args.only || f.includes(args.only));
  const reports: FolderReport[] = [];
  say(`Hivemind eval · data ${args.data} · ${folders.length} folders · onset tol −${args.tolMin}m · busy=${args.busy}`);

  for (const name of folders) {
    const dir = join(args.data, name);
    const loaded = attempt<LoadedFolder>(() => loadFolder(dir));
    if (!loaded.ok) {
      say(rule(name));
      say(`  load failed: ${loaded.error}`);
      checks.add({ folder: name, section: 'load', name: 'load folder', pass: false, detail: loaded.error });
      reports.push({ folder: name, dir, nowUnix: null, labelled: false, load: loaded.error });
      continue;
    }
    const { model, grid } = loaded.value;
    const now = gridNow(grid);
    const labels = readAnswerKey(dir);
    const rep: FolderReport = { folder: name, dir, nowUnix: now, labelled: !!labels };
    reports.push(rep);

    // ---- unlabelled folder (mock test / judging folder) ----
    if (!labels) {
      say(rule(`${name} · now ${fmtTime(now)} · no answer key`));
      const d = attempt(() => detectRules(model, grid, { asOfUnix: now }));
      rep.unlabelledDetections = d;
      if (!d.ok) say(`  detect   ${naText(d)}`);
      else {
        const on = d.value.filter((e) => e.status === 'ongoing');
        const byCat = (es: DetectedEvent[]) =>
          Object.entries(es.reduce<Record<string, number>>((m, e) => ((m[catShort[e.category] ?? e.category] = (m[catShort[e.category] ?? e.category] ?? 0) + 1), m), {}))
            .map(([k, v]) => `${k} ${v}`)
            .join(' ');
        say(`  detect   ${d.value.length} events (${byCat(d.value) || '-'}) · ongoing ${on.length}: ${on.map((e) => `${catShort[e.category]} ${e.assetId}`).join(', ') || '-'}`);
        if (args.verbose) for (const e of d.value) verbose(`    ${e.status.padEnd(8)} ${pad(e.category, 16)} ${pad(e.assetId, 16)} onset ${fmtTime(e.onsetUnix)} conf ${fmtNum(e.confidence, 2)} · ${e.evidence[0] ?? ''}`);
      }
      continue;
    }

    const ongoingN = labels.filter((l) => l.status === 'ongoing').length;
    say(rule(`${name} · now ${fmtTime(now)} · ${labels.length} labels (${ongoingN} ongoing)`));

    // ---- detection ----
    const allResolved = ongoingN === 0;
    const det = scoreDetection(model, grid, labels, { ...mo, sweepStepSec: allResolved ? args.sweepMin * 60 : 0 });
    rep.detection = det;
    if (!det.ok) {
      say(`  detect   ${naText(det)}`);
      for (const l of labels)
        checks.add({ folder: name, section: 'detect', name: `${l.id} ${l.category} ${l.asset}`, pass: det.notImplemented ? null : false });
    } else {
      const s = det.value;
      const cats = Object.entries(s.perCategory)
        .map(([c, v]) => `${catShort[c] ?? c} ${v.hits}/${v.total} ${mark(v.hits === v.total)}`)
        .join('  ');
      const fa = s.matching.falseAlarms.length;
      let line = `  detect   ${cats} │ FA ${fa} ${mark(fa === 0)} dup ${s.matching.duplicates.length}`;
      if (s.ongoing.total) line += ` │ ongoing ${s.ongoing.hits}/${s.ongoing.total} ${mark(s.ongoing.hits === s.ongoing.total)}`;
      line += ` │ onsetΔ med ${fmtMin(s.onsetDeltaMedianSec)} max|${fmtMin(s.onsetDeltaMaxAbsSec)}|`;
      if (s.sweep) line += ` │ first-seen med ${fmtMin(s.latencyMedianSec)} max ${fmtMin(s.latencyMaxSec)} (${s.sweep.calls}×, ${(s.sweep.ms / 1000).toFixed(1)}s${s.sweep.error ? ', ERR' : ''})`;
      say(line);
      for (const m of s.matching.matches) {
        checks.add({
          folder: name,
          section: 'detect',
          name: `${m.label.id} ${m.label.category} ${m.label.asset}`,
          pass: !!m.detected,
          detail: m.detected ? `onsetΔ ${fmtMin(m.onsetDeltaSec)}` : 'missed',
        });
        if (m.label.status === 'ongoing')
          checks.add({ folder: name, section: 'detect', name: `${m.label.id} detected as ongoing`, pass: m.detected?.status === 'ongoing' });
        verbose(
          `    ${pad(m.label.id, 9)} ${pad(catShort[m.label.category] ?? m.label.category, 5)} ${pad(m.label.asset, 15)} onset ${fmtTime(m.label.onsetUnix)} ${
            m.detected
              ? `✓ Δ ${fmtMin(m.onsetDeltaSec)} status ${m.detected.status}${m.statusOk ? '' : ' ✗'} first-seen ${m.firstSeenUnix ? `+${fmtMin(m.firstSeenUnix - m.label.onsetUnix)}` : '-'} conf ${fmtNum(m.detected.confidence, 2)}`
              : '✗ missed'
          }`,
        );
      }
      checks.add({ folder: name, section: 'detect', name: 'no false alarms', pass: fa === 0, detail: `${fa}` });
      for (const e of s.matching.falseAlarms) verbose(`    FA  ${pad(e.category, 16)} ${pad(e.assetId, 15)} onset ${fmtTime(e.onsetUnix)} ${e.status} · ${e.evidence[0] ?? ''}`);
      for (const e of s.matching.duplicates) verbose(`    DUP ${pad(e.category, 16)} ${pad(e.assetId, 15)} onset ${fmtTime(e.onsetUnix)} ${e.status}`);
    }

    if (allResolved) {
      // ---- full_week-style replay ----
      const r = replayFullWeek(model, grid, labels, args.tol.costUsd, args.busy);
      rep.replay = r;
      const passN = r.rows.filter((x) => x.pass).length;
      say(`  plans    each pump failure planned at its onset (earlier plans followed) · ${passN}/${r.rows.length} ≤ ref`);
      const firstErr = r.rows.find((x) => !x.plan.ok);
      for (const x of r.rows) {
        const ourTxt = x.plan.ok ? fmtActions(x.ours?.actions) : '';
        const cells = x.plan.ok ? costCell(x.ours?.cost, x.ref.cost, x.pass, x.better) : '';
        say(
          `   ${pad(x.label.id, 9)}${pad(x.label.facility, 14)} lvl ${lpad(fmtNum(x.levelPct), 4)} free ${pad(`${x.ourFree}/${x.fleetSize}${x.freeOk ? '' : ` ✗ref ${x.refFree}`}`, 9)}│ ref ${pad(refShort(x.ref), 34)}${
            x.plan.ok ? `│ ours ${pad(ourTxt, 30)} ${cells}` : `│ ${naText(x.plan as any)}`
          }`,
        );
        checks.add({ folder: name, section: 'plan', name: `${x.label.id} cost ≤ ref`, pass: x.pass, flag: x.better ? 'better than reference?' : undefined, detail: `${fmtUsd(x.ours?.cost)} vs ${fmtUsd(x.ref.cost)}` });
        checks.add({ folder: name, section: 'plan', name: `${x.label.id} free trucks`, pass: x.plan.ok ? x.freeOk : null, detail: `${x.ourFree} vs ${x.refFree}` });
        if (x.ours) verbose(`      ${x.ours.summary} · do-nothing ${fmtUsd(x.ours.doNothingCost)} · trips-if-nothing ${fmtTime(x.ours.tripsAtUnixIfNothing)} (ref ${fmtTime(x.label.tripsAtUnix)}) · peak ${fmtNum(x.ours.peakLevelPct)}%`);
      }
      say(`   total    ours ${fmtUsd(r.ourTotal)} vs ref ${fmtUsd(r.refTotal)}${firstErr ? '' : ` ${mark(r.ourTotal != null && r.ourTotal <= r.refTotal + args.tol.costUsd)}`}`);
      if (r.sanity) {
        const z = r.sanity;
        if (!z.plan.ok) say(`  sanity   ${z.label.id} ${z.label.facility}: ${naText(z.plan)}`);
        else
          say(
            `  sanity   ${z.label.id} ${z.label.facility}: do-nothing ${fmtUsd(z.doNothingCost)} · no-trucks ${z.noTrucks.ok ? fmtUsd(z.noTruckCost) : 'N/A'} · plan ${fmtUsd(z.planCost)} (${fmtActions(z.actions)}) vs ref ${fmtUsd(z.label.reference.cost)} ${mark(z.pass)}`,
          );
        checks.add({ folder: name, section: 'sanity', name: `${z.label.id} single-truck example`, pass: z.pass });
        if (z.plan.ok && z.noTrucks.ok && z.doNothingCost != null && z.noTruckCost != null && z.planCost != null)
          checks.add({ folder: name, section: 'sanity', name: `${z.label.id} plan ≤ no-trucks ≤ do-nothing`, pass: z.planCost <= z.noTruckCost + 1e-6 && z.noTruckCost <= z.doNothingCost + 1e-6 });
      }
    } else {
      // ---- snapshot: countdown, alerts, joint plans from now ----
      const o = scoreSnapshotOracle(model, grid, labels, args.tol);
      rep.oracle = o;
      printSnapshotMode(o, name, true);
      const detEvents: Attempt<DetectedEvent[]> = det.ok ? { ok: true, value: det.value.detected } : det;
      const d = scoreSnapshotDetected(model, grid, labels, detEvents, args.tol, mo);
      rep.detected = d;
      printSnapshotMode(d, name, false);
    }
  }

  function printSnapshotMode(r: SnapshotModeResult, folder: string, full: boolean) {
    const sec = r.mode;
    if (!r.available.ok) {
      say(`  ${pad(sec, 8)} ${naText(r.available)}`);
      return;
    }
    if (full) {
      for (const c of r.countdown) {
        const cd = c.countdown;
        const lvl = cd.ok ? `lvl ${fmtNum(cd.value.levelPct)}/${fmtNum(c.label.levelFinalPct)} ${mark(c.levelOk)}  h ${fmtNum(cd.value.hoursToLimitP50, 2)}/${fmtNum(c.label.hoursToLimitFinal, 2)} ${mark(c.hoursOk)}` : `countdown ${naText(cd)}`;
        say(`  ${pad(sec, 8)} ${pad(c.label.id, 9)}${pad(c.label.facility, 14)} ${lvl}  order ${c.ourOrder ?? '-'}/${c.label.order ?? '-'} ${mark(c.orderOk)}  rev/h ${mark(c.revenueOk)}`);
      }
      for (const s of r.systems) {
        say(`  ${pad('plan', 8)} ${pad(s.systemId, 23)} ${s.plan.ok ? `system ${costCell(s.plan.value.totalCost, s.refTotal, s.pass, s.better)}` : naText(s.plan)}`);
        for (const x of s.rows)
          say(
            `   ${pad(x.label.id, 9)}${pad(x.label.facility, 14)} │ ref ${pad(refShort(x.ref), 34)}${x.ours ? `│ ours ${pad(fmtActions(x.ours.actions), 30)} ${lpad(fmtUsd(x.ours.cost), 7)} vs ${lpad(fmtUsd(x.ref.cost), 7)}` : ''}`,
          );
      }
    } else {
      const cdN = r.countdown.filter((c) => c.levelOk && c.hoursOk).length;
      const sys = r.systems.map((s) => `${s.systemId} ${s.plan.ok ? `${fmtUsd(s.plan.value.totalCost)} vs ${fmtUsd(s.refTotal ?? 0)}` : 'N/A'} ${mark(s.pass)}${s.better ? '?' : ''}`).join('  ');
      say(`  ${pad(sec, 8)} countdown ${cdN}/${r.countdown.length} ${mark(r.countdown.every((c) => c.levelOk && c.hoursOk))}  order ${mark(r.orderOk)}  plans ${sys || '-'}`);
    }
    for (const c of r.countdown) {
      checks.add({ folder, section: `${sec}:countdown`, name: `${c.label.id} level`, pass: c.levelOk });
      checks.add({ folder, section: `${sec}:countdown`, name: `${c.label.id} hours_to_limit`, pass: c.hoursOk });
      checks.add({ folder, section: `${sec}:alerts`, name: `${c.label.id} order`, pass: c.orderOk });
      if (full) checks.add({ folder, section: 'model', name: `${c.label.id} lost revenue/h`, pass: c.revenueOk });
    }
    for (const s of r.systems)
      checks.add({
        folder,
        section: `${sec}:plan`,
        name: `${s.systemId} system cost ≤ ref${s.unlabelled ? ' (unlabelled system)' : ''}`,
        pass: s.pass,
        flag: s.better ? 'better than reference?' : undefined,
        detail: `${s.plan.ok ? fmtUsd(s.plan.value.totalCost) : '-'} vs ${fmtUsd(s.refTotal)}`,
      });
    if (args.verbose)
      for (const s of r.systems) if (s.plan.ok) for (const f of s.plan.value.facilities) verbose(`      ${f.eventId} ${f.summary} · do-nothing ${fmtUsd(f.doNothingCost)} · peak ${fmtNum(f.peakLevelPct)}%`);
  }

  // ---- totals ----
  const L = checks.list;
  const pass = L.filter((c) => c.pass === true).length;
  const fail = L.filter((c) => c.pass === false);
  const na = L.filter((c) => c.pass === null).length;
  const flags = L.filter((c) => c.flag);
  const bySection = new Map<string, { p: number; f: number; n: number }>();
  for (const c of L) {
    const k = c.section.replace(/^.*:/, (m) => m); // keep "oracle:plan" etc.
    const v = bySection.get(k) ?? { p: 0, f: 0, n: 0 };
    if (c.pass === true) v.p++;
    else if (c.pass === false) v.f++;
    else v.n++;
    bySection.set(k, v);
  }
  say(rule('TOTAL'));
  say(`  ${[...bySection].map(([k, v]) => `${k} ${v.p}/${v.p + v.f}${v.n ? ` (${v.n} N/A)` : ''}`).join(' · ')}`);
  say(`  checks ${L.length}: ${pass} ✓  ${fail.length} ✗  ${na} N/A${flags.length ? ` · ${flags.length} better than reference? (review: ${flags.map((f) => `${f.folder.slice(0, 14)}:${f.name.split(' ')[0]}`).join(', ')})` : ''}`);
  if (args.verbose && fail.length) for (const f of fail) verbose(`    ✗ ${f.folder} ${f.section} ${f.name}${f.detail ? ` (${f.detail})` : ''}`);

  console.log(out.join('\n'));

  if (args.json) {
    const replacer = (_k: string, v: unknown) => (v instanceof Map ? Object.fromEntries(v) : v);
    writeFileSync(
      args.json,
      JSON.stringify({ generatedAt: new Date().toISOString(), dataRoot: args.data, args: { ...args, json: undefined }, folders: reports.map(slimReport), checks: L, summary: { total: L.length, pass, fail: fail.length, na, flagged: flags.length } }, replacer, 2),
    );
    console.log(`(json written to ${args.json})`);
  }
  if (args.strict && fail.length) process.exit(1);
}

/** Drop bulky fields (level traces, raw label JSON) from the JSON report. */
function slimReport(r: FolderReport) {
  return JSON.parse(
    JSON.stringify(r, (k, v) => {
      if (k === 'levelTrace' || k === 'raw' || k === 'label') return k === 'label' && v && typeof v === 'object' ? (v as AnswerKeyEvent).id : undefined;
      return v;
    }),
  );
}

try {
  main();
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(2);
}
