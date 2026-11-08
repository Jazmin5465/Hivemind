#!/usr/bin/env bash
# One-time / after-wipe local setup:
#   1. make sure .env exists and has a WORKER_KEY (random, never committed)
#   2. publish the module to the local SpacetimeDB server (pass --wipe to delete data)
#   3. set the worker key in the module (CLI identity = module owner)
#   4. regenerate client + worker bindings
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
DB="${SPACETIME_DB:-hivemind}"

[ -f .env ] || cp .env.example .env
if ! grep -q '^WORKER_KEY=.\+' .env; then
  KEY="$(openssl rand -hex 24)"
  if grep -q '^WORKER_KEY=' .env; then sed -i '' "s/^WORKER_KEY=.*/WORKER_KEY=$KEY/" .env; else echo "WORKER_KEY=$KEY" >> .env; fi
  echo "generated WORKER_KEY in .env"
fi
KEY="$(grep '^WORKER_KEY=' .env | cut -d= -f2-)"

if ! spacetime server ping local >/dev/null 2>&1; then
  echo "local SpacetimeDB is not running; start it with: spacetime start" >&2
  exit 1
fi

if [ "${1:-}" = "--wipe" ]; then
  spacetime publish "$DB" --server local --module-path server --delete-data=always --yes
else
  spacetime publish "$DB" --server local --module-path server --yes
fi
spacetime call "$DB" --server local set_worker_key "\"$KEY\"" >/dev/null
echo "worker key set"
spacetime generate --lang typescript --out-dir client/src/module_bindings --module-path server >/dev/null
spacetime generate --lang typescript --out-dir worker/src/module_bindings --module-path server >/dev/null
echo "bindings generated (client/src/module_bindings, worker/src/module_bindings)"
