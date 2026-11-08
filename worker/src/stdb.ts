// SpacetimeDB connection for worker processes (loader, ML bridge, agent).
// The worker keeps its own identity token in data/.worker-token (gitignored) and registers
// as a worker with WORKER_KEY (from .env), which the owner set via scripts/setup-local.sh.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import { DbConnection } from './module_bindings';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
loadEnv({ path: join(REPO_ROOT, '.env'), quiet: true } as any);

export const env = (k: string, d = '') => process.env[k] ?? d;

export interface ConnectOptions {
  name: string;
  /** subscribe to these SQL queries before resolving */
  subscribe?: string[];
  register?: boolean;
}

function tokenPath(name: string) {
  return join(REPO_ROOT, 'data', `.token-${name.replace(/[^a-z0-9_-]/gi, '_')}`);
}

export async function connect(opts: ConnectOptions): Promise<DbConnection> {
  const uri = env('SPACETIME_URI', 'ws://127.0.0.1:3000');
  const db = env('SPACETIME_DB', 'hivemind');
  const tp = tokenPath(opts.name);
  const saved = existsSync(tp) ? readFileSync(tp, 'utf8').trim() : undefined;
  const conn = await new Promise<DbConnection>((res, rej) => {
    const timer = setTimeout(() => rej(new Error(`timed out connecting to ${uri}/${db}`)), 10_000);
    DbConnection.builder()
      .withUri(uri)
      .withDatabaseName(db)
      .withToken(saved)
      .onConnect((c, _id, token) => {
        clearTimeout(timer);
        mkdirSync(dirname(tp), { recursive: true });
        writeFileSync(tp, token);
        res(c);
      })
      .onConnectError((_ctx, err) => {
        clearTimeout(timer);
        rej(err);
      })
      .build();
  });
  if (opts.register !== false) {
    const key = env('WORKER_KEY');
    if (!key) throw new Error('WORKER_KEY missing in .env (run scripts/setup-local.sh)');
    await conn.reducers.registerWorker({ key, name: opts.name });
  }
  if (opts.subscribe?.length) {
    await new Promise<void>((res, rej) => {
      conn
        .subscriptionBuilder()
        .onApplied(() => res())
        .onError((_ctx: any, err?: Error) => rej(err ?? new Error('subscription error')))
        .subscribe(opts.subscribe!);
    });
  }
  return conn;
}
