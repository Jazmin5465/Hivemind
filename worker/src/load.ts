// Upload a dataset folder into the module through the load reducers.
import type { DbConnection } from './module_bindings';
import { loadFolder, type LoadedFolder } from './folder';
import { splitSeriesKey, tEnd } from '../../core/src/telemetry';

export const CHUNK_STEPS = 288; // one day per row (must match server CHUNK_STEPS semantics)
const MAX_VALUES_PER_CALL = 40_000; // keep each reducer message well under the size limit

export interface LoadResult {
  datasetId: string;
  rows: number;
  series: number;
  chunks: number;
  calls: number;
  parseMs: number;
  uploadMs: number;
}

export async function uploadFolder(
  conn: DbConnection,
  dir: string,
  opts: { datasetId?: string; activate?: boolean; log?: (s: string) => void } = {},
): Promise<LoadResult> {
  const log = opts.log ?? (() => {});
  const t0 = Date.now();
  let d: LoadedFolder;
  try {
    d = loadFolder(dir, opts.datasetId);
  } catch (e) {
    throw new Error(`could not read dataset folder ${dir}: ${(e as Error).message}`);
  }
  const parseMs = Date.now() - t0;
  const { grid } = d;
  log(`parsed ${d.datasetId}: ${grid.rowCount} rows, ${grid.series.size} series, ${grid.n} steps (${parseMs} ms)`);

  const t1 = Date.now();
  await conn.reducers.loadDatasetBegin({ datasetId: d.datasetId, source: d.dir, networkJson: d.networkText, opsJson: d.opsText });
  let batch: { assetId: string; metric: string; chunkIdx: number; t0: number; values: number[] }[] = [];
  let batchValues = 0;
  let calls = 1;
  let chunks = 0;
  const flush = async () => {
    if (!batch.length) return;
    await conn.reducers.loadDatasetChunk({ datasetId: d.datasetId, stepSec: grid.stepSec, chunks: batch });
    calls++;
    batch = [];
    batchValues = 0;
  };
  try {
    for (const [key, arr] of grid.series) {
      const [assetId, metric] = splitSeriesKey(key);
      for (let c = 0; c * CHUNK_STEPS < grid.n; c++) {
        const start = c * CHUNK_STEPS;
        const values = Array.from(arr.subarray(start, Math.min(grid.n, start + CHUNK_STEPS)));
        batch.push({ assetId, metric, chunkIdx: c, t0: grid.t0 + start * grid.stepSec, values });
        batchValues += values.length;
        chunks++;
        if (batchValues >= MAX_VALUES_PER_CALL) await flush();
      }
    }
    await flush();
    await conn.reducers.loadDatasetEnd({
      datasetId: d.datasetId,
      tStart: grid.t0,
      tEnd: tEnd(grid),
      stepSec: grid.stepSec,
      nSteps: grid.n,
      seriesCount: grid.series.size,
      rowCount: grid.rowCount,
      activate: opts.activate ?? true,
    });
    calls++;
  } catch (e) {
    await conn.reducers.loadDatasetFail({ datasetId: d.datasetId, error: String((e as Error).message ?? e) }).catch(() => {});
    throw e;
  }
  const uploadMs = Date.now() - t1;
  log(`uploaded ${d.datasetId}: ${chunks} chunks in ${calls} calls (${uploadMs} ms)`);
  return { datasetId: d.datasetId, rows: grid.rowCount, series: grid.series.size, chunks, calls, parseMs, uploadMs };
}
