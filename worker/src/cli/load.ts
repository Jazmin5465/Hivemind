// npm run data:load -- <folder> [<folder> ...] [--id <datasetId>] [--no-activate] [--all <root>]
// Loads any dataset folder (network.json, ops.json, telemetry.csv) with no code changes.
import { readdirSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { connect } from '../stdb';
import { uploadFolder } from '../load';

const args = process.argv.slice(2);
let id: string | undefined;
let activate = true;
const folders: string[] = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--id') id = args[++i];
  else if (a === '--no-activate') activate = false;
  else if (a === '--all') {
    const root = resolve(args[++i]);
    for (const n of readdirSync(root).sort()) {
      const p = join(root, n);
      if (statSync(p).isDirectory() && existsSync(join(p, 'telemetry.csv'))) folders.push(p);
    }
  } else folders.push(a);
}
if (!folders.length) {
  console.error('usage: npm run data:load -- <folder> [--id <datasetId>] [--no-activate] | --all <root>');
  process.exit(2);
}
if (id && folders.length > 1) {
  console.error('--id only works with a single folder');
  process.exit(2);
}

const t0 = Date.now();
const conn = await connect({ name: 'loader' });
let failed = 0;
for (const [i, f] of folders.entries()) {
  try {
    // with several folders, activate only the last one
    const r = await uploadFolder(conn, f, { datasetId: id, activate: activate && i === folders.length - 1, log: (s) => console.log(s) });
    console.log(`✓ ${r.datasetId} ready (${((r.parseMs + r.uploadMs) / 1000).toFixed(1)} s)`);
  } catch (e) {
    failed++;
    console.error(`✗ ${f}: ${(e as Error).message}`);
  }
}
console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
conn.disconnect();
process.exit(failed ? 1 : 0);
