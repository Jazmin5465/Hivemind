// The Hivemind agent loop: diagnose -> plan -> what-ifs -> critic (validate, at most one
// re-plan) -> propose/endorse -> operator summary + dispatch messages. Questions and the shift
// handoff use the same tools. Every user-visible text passes the number verifier; on mismatch
// the LLM regenerates (max 2), then a template built only from tool output is used.
import { randomUUID } from 'node:crypto';
import type { PlanOverrides } from '../../../core/src/planner';
import { describeUnsupported, verifyText } from '../../../core/src/verifier';
import { LlmClient, type ChatMessage } from './llm';
import { datasetCtx, systemFailures } from './context';
import { safeJson, ToolBox, Trace, type PlanSummary } from './tools';
import * as tpl from './templates';
import type { AgentBackend, QuestionRow } from './state';

const MAX_REGEN = 2;
const MAX_TOOL_ROUNDS = 3;

const SYSTEM_PROMPT = `You are Hivemind's night-shift assistant for a produced-water network (wells -> tank -> pump -> pipeline -> disposal site).
Rules:
- Every number you write (dollars, times, hours, minutes, percents, counts of trucks/trips/wells) MUST be copied from tool results. Never compute or estimate new numbers.
- Times are UTC. Plans come from the exact optimizer (plan_system); do not invent plans.
- Be brief and concrete. Operators read this in 30 seconds. Write plain operator English: no code or field names (say "trucks free", not "trucksAvailable").`;

export interface RunOutcome {
  runId: string;
  status: 'done' | 'failed';
  summary: string;
  textSource: 'llm' | 'template';
  latencyMs: number;
}

export class AgentRunner {
  constructor(readonly backend: AgentBackend, readonly llm: LlmClient, readonly log: (s: string) => void = () => {}) {}

  private async start(datasetId: string, eventId: string, trigger: string, questionId?: bigint) {
    const runId = randomUUID();
    await this.backend.runStart({ runId, datasetId, eventId, trigger, provider: this.llm.provider, model: this.llm.model, questionId });
    const trace = new Trace(this.backend, runId);
    // ops constants are always quotable
    try {
      const c = datasetCtx(this.backend, datasetId);
      trace.facts.addDollars(c.model.costPerTrip).addVolume(c.model.truckCapacityBbl).addPercent(c.model.shutdownPct, c.model.warningPct).addTime(c.nowUnix).addHours(c.model.repairHoursPumpFailure);
    } catch (e) {
      await trace.step('tool', 'load_dataset', { datasetId }, `error: ${(e as Error).message}`, false, 0);
    }
    return { runId, trace, tools: new ToolBox({ backend: this.backend, datasetId, trace }), t0: Date.now() };
  }

  private async finish(runId: string, t0: number, status: 'done' | 'failed', summary: string, error = '', planId?: bigint) {
    const latencyMs = Date.now() - t0;
    await this.backend.runFinish({ runId, status, summary, error, latencyMs, planId }).catch((e) => this.log(`runFinish failed: ${e.message}`));
    return latencyMs;
  }

  /** Pump failures in one system (jointly) — the main event-triggered run. */
  async runSystem(datasetId: string, systemId: string, eventIds: string[], trigger: string): Promise<RunOutcome> {
    const { runId, trace, tools, t0 } = await this.start(datasetId, eventIds[0] ?? '', trigger);
    try {
      // 1. diagnose
      const events: Record<string, any>[] = [];
      for (const id of eventIds) {
        const r = (await tools.call('get_event_context', { eventId: id })) as Record<string, any>;
        if (!r.error) events.push(r);
      }
      const sys = (await tools.call('get_system_state', { systemId })) as Record<string, any>;
      // 2. plan
      let base = (await tools.call('plan_system', { systemId })) as PlanSummary & { error?: string };
      if (base.error) {
        const summary = `${systemId}: nothing to plan (${base.error}).`;
        const ms = await this.finish(runId, t0, 'done', summary);
        return { runId, status: 'done', summary, textSource: 'template', latencyMs: ms };
      }
      // 3. what-ifs: lose a truck, repair 2 h longer
      const whatifs: PlanSummary[] = [];
      if (sys.fleetSize > 0) {
        const w = (await tools.call('plan_system', { systemId, overrides: { fleetSize: sys.fleetSize - 1 }, label: `one truck fewer (${sys.fleetSize - 1} left)` })) as PlanSummary & { error?: string };
        if (!w.error) whatifs.push(w);
      }
      const w2 = (await tools.call('plan_system', { systemId, overrides: { extraRepairHours: 2 }, label: 'repair 2 h longer' })) as PlanSummary & { error?: string };
      if (!w2.error) whatifs.push(w2);
      for (const w of whatifs) await tools.call('compare_plans', { a: base.ref, b: w.ref });

      // 4. optional LLM exploration (extra what-ifs) + draft
      let draft: string | null = null;
      const msgs: ChatMessage[] = [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content:
            `New pump failure alert(s) in ${systemId}. Tool results so far:\n` +
            safeJson({ events, system: sys, baselinePlan: strip(base), whatifs: whatifs.map(strip) }) +
            `\nYou may call plan_system / simulate_tank / compare_plans for up to ${MAX_TOOL_ROUNDS} more what-ifs if useful. ` +
            `${firstShutdownFact(base)} ` +
            `The RECOMMENDED plan is ${base.ref}; its actions are exactly: ${base.facilities.map((f) => `${f.facilityId}: ${f.summary}`).join('; ')}. ` +
            `What-if plans are for comparison only: never present their actions as instructions.\n` +
            `Reply with one section:\nSUMMARY: what is failing, when the first tank shuts in, the recommended plan ${base.ref} (its actions as listed above) with its cost vs doing nothing, and the most important what-if as a comparison (max 80 words).\n` +
            `Do not write crew dispatch instructions; they are generated from the approved plan.`,
        },
      ];
      if (this.llm.enabled) draft = await this.explore(trace, tools, msgs);

      // 5. critic: validate fleet, trip timing, tank volume; at most one re-plan
      let crit = tools.critic(systemId, tools.plans.get(base.ref)!.raw);
      await trace.step('critic', 'validate_plan', { planRef: base.ref }, crit.valid ? `valid: ${crit.trucksUsed}/${crit.trucksAvailable} trucks, all trips before repair end, tanks below shutdown` : `invalid: ${crit.errors.join('; ')}`, crit.valid, 0);
      if (!crit.valid) {
        const again = (await tools.call('plan_system', { systemId, label: 're-plan after critic' })) as PlanSummary & { error?: string };
        if (!again.error) {
          base = again;
          crit = tools.critic(systemId, tools.plans.get(base.ref)!.raw);
          await trace.step('critic', 'validate_plan', { planRef: base.ref, replan: true }, crit.valid ? 'valid after re-plan' : `still invalid: ${crit.errors.join('; ')}`, crit.valid, 0);
        }
      }

      // 6. propose / endorse (validated again inside propose_plan)
      let planId: bigint | undefined;
      if (crit.valid) {
        const rationale = `Optimizer plan ${usdShort(base.totalCost)} vs ${usdShort(base.doNothingCost)} if nothing is done; checked against fleet, trip timing and tank limits.`;
        const pr = (await tools.call('propose_plan', { systemId, planRef: base.ref, rationale })) as Record<string, any>;
        if (pr.endorsedPlanId != null) planId = BigInt(pr.endorsedPlanId);
      }

      // 7. texts (verified)
      const template = tpl.failureSummary(systemId, base, events, whatifs);
      const dispatchTpl = base.facilities.flatMap((f) => [tpl.truckDispatch(f, base), tpl.shutInDispatch(f)]).filter((x): x is string => !!x);
      const { summary, dispatch, source } = await this.guardSections(trace, msgs, draft, template, dispatchTpl, (text) => checkShutdownTimes(text, [base, ...whatifs]));
      for (const [i, text] of dispatch.entries()) {
        const f = base.facilities[Math.min(i, base.facilities.length - 1)];
        await this.backend.dispatchMessage({ runId, datasetId, planId, eventId: f?.eventId ?? eventIds[0] ?? '', recipient: /inspect/i.test(text) ? 'field inspector' : /truck/i.test(text) ? `truck crew ${systemId}` : 'field crew', text });
      }
      const ms = await this.finish(runId, t0, 'done', summary, '', planId);
      this.log(`run ${runId.slice(0, 8)} ${systemId} done in ${ms} ms (${source})`);
      return { runId, status: 'done', summary, textSource: source, latencyMs: ms };
    } catch (e) {
      const msg = (e as Error).message;
      await trace.step('fallback', 'run_error', {}, msg, false, 0);
      const ms = await this.finish(runId, t0, 'failed', '', msg);
      return { runId, status: 'failed', summary: '', textSource: 'template', latencyMs: ms };
    }
  }

  /** Leak or worn pump: inspection, no trucks. */
  async runInspection(datasetId: string, eventId: string, trigger: string): Promise<RunOutcome> {
    const { runId, trace, tools, t0 } = await this.start(datasetId, eventId, trigger);
    try {
      const e = (await tools.call('get_event_context', { eventId })) as Record<string, any>;
      if (e.error) throw new Error(e.error);
      const template = tpl.inspectionSummary(e);
      const msgs: ChatMessage[] = [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `New alert. Tool result:\n${safeJson(e)}\nReply with:\nSUMMARY: what is wrong, since when, the confidence, the key evidence and that an inspector should go (max 60 words).` },
      ];
      let draft: string | null = null;
      if (this.llm.enabled) draft = await this.draftOnly(trace, msgs);
      const { summary, dispatch, source } = await this.guardSections(trace, msgs, draft, template, [tpl.inspectorDispatch(e)]);
      for (const text of dispatch) await this.backend.dispatchMessage({ runId, datasetId, planId: undefined, eventId, recipient: 'field inspector', text });
      const ms = await this.finish(runId, t0, 'done', summary);
      return { runId, status: 'done', summary, textSource: source, latencyMs: ms };
    } catch (e) {
      const msg = (e as Error).message;
      const ms = await this.finish(runId, t0, 'failed', '', msg);
      return { runId, status: 'failed', summary: '', textSource: 'template', latencyMs: ms };
    }
  }

  /** Natural-language question -> planner calls -> verified answer. */
  async answerQuestion(q: QuestionRow): Promise<RunOutcome> {
    const { runId, trace, tools, t0 } = await this.start(q.datasetId, '', 'question', q.id);
    try {
      const c = datasetCtx(this.backend, q.datasetId);
      const intent = parseQuestion(q.text, c.model.systems.map((s) => ({ id: s.id, fleet: s.fleetSize, facilityIds: s.facilityIds })), c.model.wells.map((w) => w.id));
      const handoff = (await tools.call('draft_handoff', {})) as Record<string, any>;
      let answerTpl: string;
      if (intent.kind === 'handoff') {
        answerTpl = tpl.handoffText(handoff);
      } else if (intent.kind === 'whatif') {
        const systems = intent.systemIds.length ? intent.systemIds : c.model.systems.map((s) => s.id).filter((id) => systemFailures(c, id).failures.length);
        const parts: string[] = [];
        for (const sid of systems) {
          const base = (await tools.call('plan_system', { systemId: sid })) as PlanSummary & { error?: string };
          if (base.error) continue;
          const o = intent.overrides(sid);
          const alt = (await tools.call('plan_system', { systemId: sid, overrides: o })) as PlanSummary & { error?: string };
          if (alt.error) continue;
          await tools.call('compare_plans', { a: base.ref, b: alt.ref });
          parts.push(tpl.whatifAnswer(q.text, base, alt));
        }
        answerTpl = parts.length ? parts.join(' ') : `No unplanned pump failures to re-plan right now. ${tpl.statusAnswer(handoff)}`;
      } else {
        answerTpl = tpl.statusAnswer(handoff);
      }
      let draft: string | null = null;
      const msgs: ChatMessage[] = [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: `Operator ${q.askerName} asks: "${q.text}"\nCurrent situation (tool result):\n${safeJson(handoff)}\n` +
            `Use plan_system with overrides (fleetSize, extraRepairHours, repairHours, lockedWells, noTrucks) for what-if questions, then answer in at most 80 words. Reply with:\nSUMMARY: <answer>`,
        },
      ];
      if (this.llm.enabled) draft = await this.explore(trace, tools, msgs);
      const { summary, source } = await this.guardSections(trace, msgs, draft, answerTpl, []);
      await this.backend.answer({ runId, questionId: q.id, answer: summary, ok: true });
      if (intent.kind === 'handoff') await this.backend.postHandoff({ runId, datasetId: q.datasetId, text: summary });
      const ms = await this.finish(runId, t0, 'done', summary);
      return { runId, status: 'done', summary, textSource: source, latencyMs: ms };
    } catch (e) {
      const msg = (e as Error).message;
      await this.backend.answer({ runId, questionId: q.id, answer: `Sorry, I couldn't answer that: ${msg}`, ok: false }).catch(() => {});
      const ms = await this.finish(runId, t0, 'failed', '', msg);
      return { runId, status: 'failed', summary: '', textSource: 'template', latencyMs: ms };
    }
  }

  /** Plain-English shift handoff (30-second read). */
  async handoff(datasetId: string, trigger = 'handoff'): Promise<RunOutcome> {
    const { runId, trace, tools, t0 } = await this.start(datasetId, '', trigger);
    try {
      const h = (await tools.call('draft_handoff', {})) as Record<string, any>;
      const template = tpl.handoffText(h);
      const msgs: ChatMessage[] = [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `Write the shift handoff for the next operator from this tool result:\n${safeJson(h)}\nMost urgent first; for each pump failure: time to shutdown, plan and its status, owner. Then leaks/worn pumps. Max 110 words. Reply with:\nSUMMARY: <handoff>` },
      ];
      let draft: string | null = null;
      if (this.llm.enabled) draft = await this.draftOnly(trace, msgs);
      const { summary, source } = await this.guardSections(trace, msgs, draft, template, []);
      await this.backend.postHandoff({ runId, datasetId, text: summary });
      const ms = await this.finish(runId, t0, 'done', summary);
      return { runId, status: 'done', summary, textSource: source, latencyMs: ms };
    } catch (e) {
      const msg = (e as Error).message;
      const ms = await this.finish(runId, t0, 'failed', '', msg);
      return { runId, status: 'failed', summary: '', textSource: 'template', latencyMs: ms };
    }
  }

  // ---------- LLM helpers ----------
  private async explore(trace: Trace, tools: ToolBox, msgs: ChatMessage[]): Promise<string | null> {
    const specs = ToolBox.specs().filter((s) => s.function.name !== 'propose_plan');
    try {
      for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
        if (round === MAX_TOOL_ROUNDS) msgs.push({ role: 'user', content: 'Tool budget used. Do not call tools. Reply now with the SUMMARY: section in plain sentences.' });
        const r = await this.llm.chat(msgs, round < MAX_TOOL_ROUNDS ? specs : undefined);
        const calls = r.message.tool_calls ?? [];
        await trace.step('llm', 'chat', { round, tools: calls.map((c) => c.function.name) }, calls.length ? `requested ${calls.length} tool call(s)` : (r.message.content ?? '').slice(0, 500), true, r.latencyMs);
        if (!calls.length) {
          msgs.push({ role: 'assistant', content: r.message.content });
          return r.message.content ?? '';
        }
        msgs.push({ role: 'assistant', content: r.message.content ?? '', tool_calls: calls });
        for (const call of calls) {
          let args: Record<string, any> = {};
          try {
            args = JSON.parse(call.function.arguments || '{}');
          } catch {
            /* bad JSON from the model: pass empty args, the tool returns an error */
          }
          const res = await tools.call(call.function.name, args);
          msgs.push({ role: 'tool', tool_call_id: call.id, name: call.function.name, content: safeJson(stripDeep(res)).slice(0, 6000) });
        }
      }
    } catch (e) {
      await trace.step('llm', 'chat', {}, `LLM error: ${(e as Error).message}`, false, 0);
    }
    return null;
  }

  private async draftOnly(trace: Trace, msgs: ChatMessage[]): Promise<string | null> {
    try {
      const r = await this.llm.chat(msgs);
      await trace.step('llm', 'chat', {}, (r.message.content ?? '').slice(0, 500), true, r.latencyMs);
      msgs.push({ role: 'assistant', content: r.message.content });
      return r.message.content ?? '';
    } catch (e) {
      await trace.step('llm', 'chat', {}, `LLM error: ${(e as Error).message}`, false, 0);
      return null;
    }
  }

  /** Verify the LLM summary; regenerate up to 2x; else templates. Dispatch always comes from the plan. */
  private async guardSections(
    trace: Trace,
    msgs: ChatMessage[],
    draft: string | null,
    template: string,
    dispatchTpl: string[],
    semantic?: (summary: string) => string | null,
  ) {
    let text = draft;
    for (let attempt = 0; text != null && attempt <= MAX_REGEN; attempt++) {
      // Only the operator summary comes from the LLM. Crew dispatch messages are always built from
      // the endorsed plan's own actions, so crews can never get instructions that differ from it
      // (an LLM can quote real numbers from a what-if plan and still pass the number check).
      const { summary } = splitSections(text);
      // A model can emit a tool call as plain text (e.g. after its tool-call budget is used up).
      // That is not a summary: ask again instead of storing markup.
      if (looksLikeToolMarkup(summary) || summary.length < 20) {
        await trace.step('verifier', 'format_check', { attempt }, 'rejected: reply was a tool call or empty, not a summary', false, 0);
        if (attempt === MAX_REGEN) break;
        msgs.push({ role: 'user', content: 'Do not call any more tools. Using only the tool results above, reply now with a SUMMARY: section in plain sentences.' });
        text = await this.draftOnly(trace, msgs);
        continue;
      }
      const v = verifyText(summary, trace.facts);
      await trace.step('verifier', 'number_check', { attempt }, v.ok ? `ok: ${v.claims.length} numbers checked` : `unsupported: ${describeUnsupported(v)}`, v.ok, 0);
      const sem = v.ok && summary && semantic ? semantic(summary) : null;
      if (semantic && v.ok && summary) await trace.step('verifier', 'fact_check', { attempt }, sem ? `rejected: ${sem}` : 'ok: shutdown times match the plan', !sem, 0);
      if (v.ok && summary && !sem) {
        await trace.step('verifier', 'dispatch_from_plan', {}, `${dispatchTpl.length} dispatch message(s) built from the endorsed plan's actions`, true, 0);
        return { summary, dispatch: dispatchTpl, source: 'llm' as const };
      }
      if (attempt === MAX_REGEN) break;
      msgs.push({
        role: 'user',
        content: sem
          ? `${sem} Rewrite the SUMMARY with the correct facts from the tool results.`
          : v.ok
            ? 'Your reply had no SUMMARY section. Reply again with a SUMMARY: section.'
            : `These numbers are not in the tool results: ${describeUnsupported(v)}. Rewrite using only numbers that appear in the tool results. Keep the SUMMARY section.`,
      });
      text = await this.draftOnly(trace, msgs);
    }
    const v = verifyText([template, ...dispatchTpl].join('\n'), trace.facts);
    await trace.step('fallback', 'template', { reason: this.llm.enabled ? 'LLM text failed verification or LLM unavailable' : 'LLM_PROVIDER=template' }, v.ok ? 'template text (numbers verified)' : `template text; unverified numbers: ${describeUnsupported(v)}`, true, 0);
    return { summary: template, dispatch: dispatchTpl, source: 'template' as const };
  }
}

export function splitSections(text: string): { summary: string; dispatch: string[] } {
  const t = text.replace(/\r/g, '');
  const sm = t.match(/SUMMARY:\s*([\s\S]*?)(?:\n\s*DISPATCH:|$)/i);
  const dm = t.match(/DISPATCH:\s*([\s\S]*)$/i);
  const summary = (sm ? sm[1] : dm ? '' : t).trim();
  const dispatch = dm ? dm[1].split('\n').map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim()).filter(Boolean).slice(0, 6) : [];
  return { summary, dispatch };
}

function strip(p: PlanSummary): Record<string, unknown> {
  // keep what the model needs; drop raw unix arrays it might misread
  return {
    ref: p.ref, label: p.label, totalCost: p.totalCost, doNothingCost: p.doNothingCost, savings: p.savings, trucksAvailable: p.trucksAvailable,
    facilities: p.facilities.map((f) => ({ facilityId: f.facilityId, summary: f.summary, cost: f.cost, doNothingCost: f.doNothingCost, tripsAtIfNothing: f.tripsAtIfNothing, repairEnd: f.repairEnd, truckArrivals: f.truckArrivals, shutInAt: f.shutInAt, peakLevelPct: f.peakLevelPct })),
  };
}
function stripDeep(v: unknown): unknown {
  if (v && typeof v === 'object' && 'facilities' in (v as object) && 'ref' in (v as object)) return strip(v as PlanSummary);
  return v;
}
const usdShort = (x: number) => `$${Math.round(x).toLocaleString('en-US')}`;

// ---------- question parsing (template path; the LLM path picks overrides itself) ----------
export interface QuestionIntent {
  kind: 'handoff' | 'whatif' | 'status';
  systemIds: string[];
  overrides: (systemId: string) => PlanOverrides;
}

const WORDN: Record<string, number> = { one: 1, a: 1, an: 1, two: 2, three: 3, four: 4, five: 5 };
const toN = (s: string) => (/^\d+$/.test(s) ? Number(s) : WORDN[s.toLowerCase()] ?? NaN);

export function parseQuestion(text: string, systems: { id: string; fleet: number; facilityIds: string[] }[], wellIds: string[]): QuestionIntent {
  const t = text.toLowerCase();
  const sysIds = new Set<string>();
  for (const s of systems) {
    if (new RegExp(`\\b${s.id.toLowerCase()}\\b`).test(t)) sysIds.add(s.id);
    for (const f of s.facilityIds) if (t.includes(f.toLowerCase())) sysIds.add(s.id);
  }
  if (/hand ?off|shift (summary|report|notes?)|brief the next/.test(t)) return { kind: 'handoff', systemIds: [...sysIds], overrides: () => ({}) };

  let fleetDelta: number | null = null;
  let fleetAbs: number | null = null;
  let noTrucks = false;
  let extra: number | null = null;
  let repairHours: number | null = null;
  let m: RegExpMatchArray | null;
  if (/no trucks|without (any )?trucks|trucks? (are |is )?(unavailable|out)|yard (is )?closed/.test(t)) noTrucks = true;
  if ((m = t.match(/\b(?:lose|lost|losing|minus|without)\s+(a|an|one|two|three|\d+)\s+(?:of (?:the |our )?)?trucks?\b/))) fleetDelta = -toN(m[1]);
  else if (/\b(one|a) (fewer|less) truck|truck (breaks|broke) down|lose a truck/.test(t)) fleetDelta = -1;
  if ((m = t.match(/\b(?:only|just)\s+(?:have\s+|got\s+|has\s+)?(one|two|three|four|five|\d+)\s+trucks?\b/))) fleetAbs = toN(m[1]);
  else if ((m = t.match(/\b(?:have|with|has)\s+(?:only\s+)?(one|two|three|four|five|\d+)\s+trucks?\b/))) fleetAbs = toN(m[1]);
  if ((m = t.match(/\b(?:add|extra|another|one more|\+)\s*(a|an|one|two|three|\d+)?\s*(?:more\s+)?trucks?\b/)) && !fleetDelta) fleetDelta = m[1] ? toN(m[1]) : 1;
  if ((m = t.match(/(\d+(?:\.\d+)?)\s*(?:h|hrs?|hours?)\s*(?:longer|more|late|extra|delay)/)) || (m = t.match(/(?:delay(?:ed)?|late|longer) (?:by )?(\d+(?:\.\d+)?)\s*(?:h|hrs?|hours?)/))) extra = Number(m[1]);
  if ((m = t.match(/repair (?:takes|will take|needs) (\d+(?:\.\d+)?)\s*(?:h|hrs?|hours?)/))) repairHours = Number(m[1]);
  const locked = /keep|can'?t|cannot|don'?t|do not|lock|must stay/.test(t) ? wellIds.filter((w) => t.includes(w.toLowerCase())) : [];

  const any = noTrucks || fleetDelta != null || fleetAbs != null || extra != null || repairHours != null || locked.length > 0;
  if (!any) return { kind: 'status', systemIds: [...sysIds], overrides: () => ({}) };
  return {
    kind: 'whatif',
    systemIds: [...sysIds],
    overrides: (sid: string) => {
      const fleet = systems.find((s) => s.id === sid)?.fleet ?? 0;
      const o: PlanOverrides = {};
      if (noTrucks) o.noTrucks = true;
      if (fleetAbs != null && Number.isFinite(fleetAbs)) o.fleetSize = Math.max(0, fleetAbs);
      else if (fleetDelta != null && Number.isFinite(fleetDelta)) o.fleetSize = Math.max(0, fleet + fleetDelta);
      if (extra != null) o.extraRepairHours = extra;
      if (repairHours != null) o.repairHours = repairHours;
      if (locked.length) o.lockedWells = locked;
      return o;
    },
  };
}

const HHMM = (u: number) => new Date(u * 1000).toISOString().slice(11, 16);

/** "First tank to reach shutdown if nothing is done: <facility> at HH:MM UTC." from the plan. */
export function firstShutdownFact(plan: PlanSummary): string {
  const f = plan.facilities.filter((x) => x.tripsAtUnixIfNothing != null).sort((a, b) => a.tripsAtUnixIfNothing! - b.tripsAtUnixIfNothing!)[0];
  return f
    ? `First tank to reach shutdown if nothing is done: ${f.facilityId} at ${HHMM(f.tripsAtUnixIfNothing!)} UTC.`
    : 'No tank reaches shutdown before its repair ends, even if nothing is done.';
}

/**
 * Fact check beyond numbers: a clock time stated as a tank *shutdown* (not a well shut-in) must be
 * a real shutdown time from the plans (trip if nothing is done, or trip under a plan). The number
 * verifier alone accepts any time that appears anywhere in tool output.
 */
export function checkShutdownTimes(text: string, plans: PlanSummary[]): string | null {
  const allowed = new Set<string>();
  for (const p of plans)
    for (const f of p.facilities) {
      if (f.tripsAtUnixIfNothing != null) allowed.add(HHMM(f.tripsAtUnixIfNothing));
      if (f.tripsAtUnix != null) allowed.add(HHMM(f.tripsAtUnix));
    }
  const bad: string[] = [];
  for (const sentence of text.split(/(?<=[.;!?])\s+/)) {
    if (!/shut\s?-?down|reach(?:es|ing)? (?:its )?(?:shutdown|limit)|\btrips?\b(?! (?:per|each))/i.test(sentence)) continue;
    for (const m of sentence.matchAll(/\b(\d{1,2}):(\d{2})\b/g)) {
      const t = `${m[1].padStart(2, '0')}:${m[2]}`;
      // a time right after "shut in <well>" is a well action, not a tank shutdown
      const before = sentence.slice(0, m.index);
      if (/shut[\s-]in\b[^.;]*$/i.test(before) && !/shut\s?-?down[^.;]*$/i.test(before)) continue;
      if (!allowed.has(t)) bad.push(t);
    }
  }
  return bad.length ? `The summary gives ${[...new Set(bad)].join(', ')} as a tank shutdown time, but the plans' shutdown times are ${[...allowed].sort().join(', ') || 'none'}.` : null;
}

/** tool-call markup leaking into text (qwen3-coder XML style, JSON function calls, chat-template tags) */
export function looksLikeToolMarkup(text: string): boolean {
  return /<\/?tool_call>|<function=|<\/?parameter[=>]|^\s*\{\s*"(name|function)"\s*:|<\|im_(start|end)\|>/m.test(text);
}
