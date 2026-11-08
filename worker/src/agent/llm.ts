// OpenAI-compatible chat client with tool calling, for Nemotron served by vLLM on Brev
// (Hadent) or NVIDIA's hosted endpoint. LLM_PROVIDER=template means no network at all:
// the runner then writes every text from templates built only from tool output.
// Keys are read from env and never logged.

export type Provider = 'brev' | 'nvidia_hosted' | 'template';

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolSpec {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ChatResult {
  message: ChatMessage;
  latencyMs: number;
  finishReason: string;
}

export interface LlmConfig {
  provider: Provider;
  baseUrl: string;
  model: string;
  apiKey: string;
  temperature: number;
  topP: number;
  enableThinking: boolean;
  timeoutMs: number;
  maxTokens: number;
}

export class LlmError extends Error {
  constructor(msg: string, readonly status?: number) {
    super(msg);
  }
}

const HOSTED_URL = 'https://integrate.api.nvidia.com/v1';

export function llmConfigFromEnv(env: Record<string, string | undefined> = process.env): LlmConfig {
  const raw = (env.LLM_PROVIDER ?? 'template').trim() as Provider;
  const provider: Provider = raw === 'brev' || raw === 'nvidia_hosted' ? raw : 'template';
  const apiKey = env.LLM_API_KEY || (provider === 'nvidia_hosted' ? env.NVIDIA_API_KEY ?? '' : '');
  return {
    provider,
    baseUrl: (env.LLM_BASE_URL || (provider === 'nvidia_hosted' ? HOSTED_URL : '')).replace(/\/+$/, ''),
    model: env.LLM_MODEL || '',
    apiKey,
    temperature: num(env.LLM_TEMPERATURE, 1.0),
    topP: num(env.LLM_TOP_P, 0.95),
    enableThinking: /^(1|true|yes)$/i.test(env.LLM_ENABLE_THINKING ?? ''),
    timeoutMs: num(env.LLM_TIMEOUT_MS, 12_000),
    maxTokens: num(env.LLM_MAX_TOKENS, 700),
  };
}

function num(v: string | undefined, d: number) {
  const x = v == null || v === '' ? NaN : Number(v);
  return Number.isFinite(x) ? x : d;
}

/** Strip reasoning blocks if the server didn't split them out (no reasoning parser). */
export function stripThinking(s: string | null | undefined): string {
  if (!s) return '';
  return s.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/^[\s\S]*<\/think>/, '').trim();
}

export class LlmClient {
  /** set false after repeated failures so the run goes straight to templates */
  healthy = true;
  private failures = 0;
  constructor(readonly cfg: LlmConfig) {
    if (cfg.provider !== 'template' && (!cfg.baseUrl || !cfg.model)) this.healthy = false;
  }

  get provider(): Provider {
    return this.cfg.provider;
  }
  get model(): string {
    return this.cfg.provider === 'template' ? 'template' : this.cfg.model;
  }
  /** true if we should try the network at all */
  get enabled(): boolean {
    return this.cfg.provider !== 'template' && this.healthy;
  }

  private headers() {
    const h: Record<string, string> = { 'content-type': 'application/json' };
    if (this.cfg.apiKey) h.authorization = `Bearer ${this.cfg.apiKey}`;
    return h;
  }

  /** GET /v1/models; returns model ids (empty on failure). */
  async listModels(): Promise<string[]> {
    if (this.cfg.provider === 'template' || !this.cfg.baseUrl) return [];
    const r = await fetchWithTimeout(`${this.cfg.baseUrl}/models`, { headers: this.headers() }, this.cfg.timeoutMs);
    if (!r.ok) throw new LlmError(`GET /models -> HTTP ${r.status}`, r.status);
    const j = (await r.json()) as { data?: { id: string }[] };
    return (j.data ?? []).map((m) => m.id);
  }

  async chat(messages: ChatMessage[], tools?: ToolSpec[], opts: { temperature?: number; maxTokens?: number } = {}): Promise<ChatResult> {
    if (!this.enabled) throw new LlmError('LLM disabled (template provider or unhealthy)');
    const body: Record<string, unknown> = {
      model: this.cfg.model,
      messages,
      temperature: opts.temperature ?? this.cfg.temperature,
      top_p: this.cfg.topP,
      max_tokens: opts.maxTokens ?? this.cfg.maxTokens,
      chat_template_kwargs: { enable_thinking: this.cfg.enableThinking },
    };
    if (tools?.length) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }
    const t0 = Date.now();
    let r: Response;
    try {
      r = await fetchWithTimeout(`${this.cfg.baseUrl}/chat/completions`, { method: 'POST', headers: this.headers(), body: JSON.stringify(body) }, this.cfg.timeoutMs);
    } catch (e) {
      this.noteFailure();
      throw new LlmError(`LLM request failed: ${(e as Error).message}`);
    }
    if (!r.ok) {
      this.noteFailure();
      const text = (await r.text().catch(() => '')).slice(0, 300);
      throw new LlmError(`LLM HTTP ${r.status}: ${text}`, r.status);
    }
    const j = (await r.json()) as any;
    const choice = j.choices?.[0];
    if (!choice?.message) {
      this.noteFailure();
      throw new LlmError('LLM response had no message');
    }
    this.failures = 0;
    const m = choice.message;
    return {
      message: {
        role: 'assistant',
        content: stripThinking(m.content),
        tool_calls: Array.isArray(m.tool_calls) && m.tool_calls.length ? m.tool_calls : undefined,
      },
      latencyMs: Date.now() - t0,
      finishReason: choice.finish_reason ?? '',
    };
  }

  private noteFailure() {
    this.failures++;
    if (this.failures >= 3) {
      this.healthy = false;
      // retry the network again after a cool-down
      setTimeout(() => {
        this.healthy = true;
        this.failures = 0;
      }, 60_000).unref?.();
    }
  }
}

async function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
}
