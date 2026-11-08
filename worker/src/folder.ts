// Load a dataset folder (network.json, ops.json, telemetry.csv) from disk.
// Only these three files are read. Never answer_key.json.
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { buildModel, type DatasetModel } from '../../core/src/model';
import { parseTelemetryCsv, type Grid } from '../../core/src/telemetry';

export const DATASET_FILES = ['network.json', 'ops.json', 'telemetry.csv'] as const;

export interface LoadedFolder {
  dir: string;
  datasetId: string;
  networkText: string;
  opsText: string;
  model: DatasetModel;
  grid: Grid & { rowCount: number };
}

export function datasetIdFromDir(dir: string): string {
  const abs = resolve(dir);
  const name = basename(abs);
  // data/test -> "test"; history folders keep their names
  return name.replace(/[^A-Za-z0-9_.-]/g, '_');
}

export function loadFolder(dir: string, datasetId?: string): LoadedFolder {
  const abs = resolve(dir);
  for (const f of DATASET_FILES) {
    if (!existsSync(join(abs, f))) throw new Error(`${abs} is missing ${f}`);
  }
  const networkText = readFileSync(join(abs, 'network.json'), 'utf8');
  const opsText = readFileSync(join(abs, 'ops.json'), 'utf8');
  const model = buildModel(JSON.parse(networkText), JSON.parse(opsText));
  const grid = parseTelemetryCsv(readFileSync(join(abs, 'telemetry.csv'), 'utf8'));
  return { dir: abs, datasetId: datasetId ?? datasetIdFromDir(abs), networkText, opsText, model, grid };
}
