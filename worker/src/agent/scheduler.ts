// Turns table changes into agent runs. Nobody has to type anything:
//  - a new (or newly ongoing) pump failure starts a joint run for its system (debounced, so
//    failures arriving together are planned together)
//  - a new leak / worn pump starts an inspection run
//  - a pending agent_question gets answered
// Runs are serialized; while the clock is playing a key runs at most once per playingMinIntervalMs.
import type { AgentRunner } from './runner';
import type { AgentBackend, EventRow } from './state';

export interface SchedulerOptions {
  debounceMs?: number;
  playingMinIntervalMs?: number;
  log?: (s: string) => void;
}

export class Scheduler {
  readonly processed = new Map<string, string>(); // eventId -> signature handled
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private lastRun = new Map<string, number>();
  private answering = new Set<string>();
  private queue: Promise<unknown> = Promise.resolve();
  private stopped = false;
  readonly debounceMs: number;
  readonly playingMinIntervalMs: number;
  private log: (s: string) => void;

  constructor(readonly backend: AgentBackend, readonly runner: AgentRunner, opts: SchedulerOptions = {}) {
    this.debounceMs = opts.debounceMs ?? 3000;
    this.playingMinIntervalMs = opts.playingMinIntervalMs ?? 30_000;
    this.log = opts.log ?? (() => {});
  }

  /** Don't redo events that already have a run (e.g. after a restart). */
  seedFromRuns() {
    const s = this.backend.state();
    const ran = new Set(s.runs.map((r) => r.eventId).filter(Boolean));
    const sysWithRun = new Set(s.events.filter((e) => ran.has(e.eventId) && e.category === 'pump_failure').map((e) => `${e.datasetId}|${e.systemId}`));
    for (const e of s.events) {
      if (e.status !== 'ongoing') continue;
      if (ran.has(e.eventId) || (e.category === 'pump_failure' && sysWithRun.has(`${e.datasetId}|${e.systemId}`))) this.processed.set(e.eventId, sig(e));
    }
  }

  /** Look at current state and schedule whatever is new. Cheap; call on every change. */
  scan() {
    if (this.stopped) return;
    const s = this.backend.state();
    const active = s.datasets.find((d) => d.active && d.status === 'ready');
    if (!active) return;
    for (const e of s.events) {
      if (e.datasetId !== active.datasetId || e.status !== 'ongoing') continue;
      if (this.processed.get(e.eventId) === sig(e)) continue;
      this.schedule(keyOf(e), active.datasetId);
    }
    for (const q of s.questions) {
      if (q.status !== 'pending' || this.answering.has(String(q.id))) continue;
      this.answering.add(String(q.id));
      this.enqueue(`question ${q.id}`, () => this.runner.answerQuestion(q));
    }
  }

  private schedule(key: string, datasetId: string) {
    if (this.timers.has(key)) return;
    const s = this.backend.state();
    const playing = s.clocks.find((c) => c.datasetId === datasetId)?.playing ?? false;
    const since = Date.now() - (this.lastRun.get(key) ?? 0);
    const wait = Math.max(this.debounceMs, playing ? this.playingMinIntervalMs - since : 0);
    this.timers.set(key, setTimeout(() => {
      this.timers.delete(key);
      this.fire(key, datasetId);
    }, wait));
  }

  private fire(key: string, datasetId: string) {
    const s = this.backend.state();
    const ds = s.datasets.find((d) => d.datasetId === datasetId);
    if (!ds?.active) return;
    const ongoing = s.events.filter((e) => e.datasetId === datasetId && e.status === 'ongoing');
    if (key.startsWith('sys:')) {
      const systemId = key.split(':')[2];
      const covered = new Set(s.plans.filter((p) => p.status === 'approved').flatMap((p) => p.eventIds));
      const evs = ongoing.filter((e) => e.category === 'pump_failure' && e.systemId === systemId && !covered.has(e.eventId));
      const fresh = evs.filter((e) => this.processed.get(e.eventId) !== sig(e));
      for (const e of ongoing.filter((x) => x.category === 'pump_failure' && x.systemId === systemId)) this.processed.set(e.eventId, sig(e));
      if (!fresh.length) return;
      this.lastRun.set(key, Date.now());
      const ids = [...fresh, ...evs.filter((e) => !fresh.includes(e))].map((e) => e.eventId);
      this.enqueue(`system ${systemId}`, () => this.runner.runSystem(datasetId, systemId, ids, 'event_new'));
    } else {
      const eventId = key.slice(5);
      const e = ongoing.find((x) => x.eventId === eventId);
      if (!e || this.processed.get(eventId) === sig(e)) return;
      this.processed.set(eventId, sig(e));
      this.lastRun.set(key, Date.now());
      this.enqueue(`inspection ${e.assetId}`, () => this.runner.runInspection(datasetId, eventId, 'event_new'));
    }
  }

  enqueue(label: string, job: () => Promise<{ status: string; latencyMs: number }>) {
    this.queue = this.queue.then(async () => {
      if (this.stopped) return;
      try {
        const r = await job();
        this.log(`${label}: ${r.status} in ${r.latencyMs} ms`);
      } catch (e) {
        this.log(`${label}: crashed (${(e as Error).message}); continuing`);
      }
    });
    return this.queue;
  }

  /** resolves when everything queued so far is done (tests) */
  idle() {
    return this.queue;
  }

  stop() {
    this.stopped = true;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }
}

const keyOf = (e: EventRow) => (e.category === 'pump_failure' ? `sys:${e.datasetId}:${e.systemId}` : `insp:${e.eventId}`);
const sig = (e: EventRow) => `${e.status}|${e.category}`;
