// npm run agent                 watch events/questions and run the agent (Ctrl-C to stop)
// npm run agent -- --handoff    post a shift handoff for the active dataset and exit
// npm run agent -- --probe      check the LLM endpoint (GET /models) and exit
// npm run agent -- --once       run once for every ongoing event of the active dataset, then exit
import { connect, env } from '../stdb';
import { LlmClient, llmConfigFromEnv } from '../agent/llm';
import { AgentRunner } from '../agent/runner';
import { Scheduler } from '../agent/scheduler';
import { AGENT_SUBSCRIPTIONS, StdbBackend } from '../agent/stdbBackend';

const args = new Set(process.argv.slice(2));
const log = (s: string) => console.log(`[agent ${new Date().toISOString().slice(11, 19)}] ${s}`);

const llm = new LlmClient(llmConfigFromEnv(process.env));
log(`LLM provider=${llm.provider} model=${llm.model || '(unset)'} base=${llm.cfg.baseUrl || '-'} key=${llm.cfg.apiKey ? 'set' : 'none'}`);

if (args.has('--probe')) {
  try {
    const models = await llm.listModels();
    log(`models: ${models.filter((m) => /nemotron/i.test(m)).join(', ') || models.slice(0, 10).join(', ') || '(none)'}`);
    if (llm.enabled) {
      const r = await llm.chat([{ role: 'user', content: 'Reply with the word ok.' }], undefined, { maxTokens: 20 });
      log(`chat ok in ${r.latencyMs} ms: ${JSON.stringify(r.message.content)}`);
    }
  } catch (e) {
    log(`probe failed: ${(e as Error).message}`);
    process.exit(1);
  }
  process.exit(0);
}

const conn = await connect({ name: env('AGENT_NAME', 'hivemind-agent'), subscribe: AGENT_SUBSCRIPTIONS });
const backend = new StdbBackend(conn);
const runner = new AgentRunner(backend, llm, log);

const activeId = () => backend.state().datasets.find((d) => d.active)?.datasetId;

if (args.has('--handoff')) {
  const ds = activeId();
  if (!ds) {
    log('no active dataset');
    process.exit(1);
  }
  const r = await runner.handoff(ds, 'manual');
  log(`handoff ${r.status} (${r.textSource}, ${r.latencyMs} ms):\n${r.summary}`);
  conn.disconnect();
  process.exit(r.status === 'done' ? 0 : 1);
}

const sched = new Scheduler(backend, runner, { log, debounceMs: Number(env('AGENT_DEBOUNCE_MS', '3000')) });
if (!args.has('--once') && !args.has('--catch-up')) sched.seedFromRuns();
const onChange = () => sched.scan();
conn.db.event.onInsert(onChange);
conn.db.event.onUpdate(onChange);
conn.db.dataset.onUpdate(onChange);
conn.db.agentQuestion.onInsert(onChange);
sched.scan();

if (args.has('--once')) {
  // wait for debounce timers, then the queue
  await new Promise((r) => setTimeout(r, sched.debounceMs + 500));
  await sched.idle();
  conn.disconnect();
  process.exit(0);
}
log(`watching active dataset ${activeId() ?? '(none)'}; Ctrl-C to stop`);
process.on('SIGINT', () => {
  sched.stop();
  conn.disconnect();
  process.exit(0);
});
