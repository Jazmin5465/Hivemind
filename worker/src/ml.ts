// Bridge to Hadent's ML sidecar (docs/ML_CONTRACT.md). The module's rules detector is the
// fallback whenever this bridge or the sidecar is down; nothing here is required for alerts.
import type { DbConnection } from './module_bindings';
import { env } from './stdb';
import { ML_METRICS } from '../../core/src/mlEvents';
import { CHUNK_STEPS } from './load';

export const mlUrl = () => env('ML_URL', 'http://127.0.0.1:8001').replace(/\/$/, '');

interface DetectAsset {
  assetId: string;
  assetType: 'pump' | 'pipeline';
  tsUnix: number[];
  probs: Partial<Record<'normal' | 'leak' | 'degradation' | 'failure', number[]>>;
}
export interface DetectResponse {
  modelVersion: string;
  asOfUnix: number;
  stepSec: number;
  computeMs?: number;
  assets: DetectAsset[];
}
export interface Driver {
  feature: string;
  text: string;
  contribution: number;
}

async function post<T>(path: string, body: unknown, timeoutMs: number): Promise<T> {
  const res = await fetch(`${mlUrl()}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`ML ${path}: HTTP ${res.status}, non-JSON body`);
  }
  if (!res.ok) throw new Error(`ML ${path}: HTTP ${res.status}: ${json?.error ?? text.slice(0, 200)}`);
  return json as T;
}

export async function mlHealth(timeoutMs = 2000): Promise<{ ok: boolean; modelVersion?: string; error?: string }> {
  try {
    const res = await fetch(`${mlUrl()}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    const j: any = await res.json();
    return res.ok && j.status === 'ok' ? { ok: true, modelVersion: j.modelVersion } : { ok: false, error: j?.error ?? `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export const mlDetect = (datasetDir: string, asOfUnix?: number) =>
  post<DetectResponse>('/detect', { datasetDir, ...(asOfUnix != null ? { asOfUnix } : {}) }, 30_000);

export const mlExplain = (datasetDir: string, assetId: string, category: string, onsetUnix: number, asOfUnix: number) =>
  post<{ drivers: Driver[] }>('/explain', { datasetDir, assetId, category, onsetUnix, asOfUnix }, 15_000);

const METRIC_FOR: Record<string, string> = {
  'pump:failure': ML_METRICS.failure,
  'pump:degradation': ML_METRICS.degradation,
  'pipeline:leak': ML_METRICS.leak,
};

/** Convert a /detect response to series chunks aligned to the dataset grid. */
export function probsToChunks(resp: DetectResponse, ds: { tStart: number; stepSec: number; nSteps: number }) {
  const chunks: { assetId: string; metric: string; chunkIdx: number; t0: number; values: number[] }[] = [];
  for (const a of resp.assets) {
    for (const [cls, vals] of Object.entries(a.probs)) {
      const metric = METRIC_FOR[`${a.assetType}:${cls}`];
      if (!metric || !vals) continue;
      const arr = new Float64Array(ds.nSteps).fill(NaN);
      a.tsUnix.forEach((ts, i) => {
        const j = Math.round((ts - ds.tStart) / ds.stepSec);
        const v = vals[i];
        if (j >= 0 && j < ds.nSteps && typeof v === 'number' && Number.isFinite(v)) arr[j] = v;
      });
      for (let c = 0; c * CHUNK_STEPS < ds.nSteps; c++) {
        const s = c * CHUNK_STEPS;
        const values = Array.from(arr.subarray(s, Math.min(ds.nSteps, s + CHUNK_STEPS)));
        if (values.every((v) => Number.isNaN(v))) continue;
        chunks.push({ assetId: a.assetId, metric, chunkIdx: c, t0: ds.tStart + s * ds.stepSec, values });
      }
    }
  }
  return chunks;
}

/** Run /detect for one dataset and store the probabilities in the module (or report the error). */
export async function syncMl(
  conn: DbConnection,
  ds: { datasetId: string; source: string; tStart: number; tEnd: number; stepSec: number; nSteps: number },
  log: (s: string) => void = () => {},
): Promise<boolean> {
  const t0 = Date.now();
  try {
    const resp = await mlDetect(ds.source, ds.tEnd);
    const chunks = probsToChunks(resp, ds);
    if (!chunks.length) throw new Error('sidecar returned no probabilities for this network');
    const BATCH = 120;
    for (let i = 0; i < chunks.length; i += BATCH) {
      await conn.reducers.mlPutProbs({
        datasetId: ds.datasetId,
        modelVersion: resp.modelVersion,
        asOfUnix: resp.asOfUnix,
        computeMs: resp.computeMs ?? 0,
        replace: i === 0,
        chunks: chunks.slice(i, i + BATCH),
      });
    }
    await conn.reducers.mlSetStatus({ datasetId: ds.datasetId, ok: true, modelVersion: resp.modelVersion, asOfUnix: resp.asOfUnix, computeMs: resp.computeMs ?? 0, error: '' });
    log(`ML ${ds.datasetId}: ${resp.assets.length} assets, ${chunks.length} chunks, model ${resp.modelVersion} (${Date.now() - t0} ms)`);
    return true;
  } catch (e) {
    const msg = (e as Error).message;
    await conn.reducers.mlSetStatus({ datasetId: ds.datasetId, ok: false, modelVersion: '', asOfUnix: 0, computeMs: 0, error: msg.slice(0, 500) }).catch(() => {});
    log(`ML ${ds.datasetId}: unavailable, rules detector in use (${msg})`);
    return false;
  }
}
