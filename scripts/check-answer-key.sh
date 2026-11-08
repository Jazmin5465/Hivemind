#!/usr/bin/env bash
# answer_key must never appear in app code. Only scripts/eval/ may read it.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
hits=$(grep -rIl --exclude-dir=node_modules --exclude-dir=module_bindings -i "answer_key" "$ROOT/server" "$ROOT/core" "$ROOT/worker" "$ROOT/client" 2>/dev/null || true)
if [ -n "$hits" ]; then
  echo "FAIL: answer_key referenced in app code:"; echo "$hits"; exit 1
fi
echo "OK: no answer_key references in server/ core/ worker/ client/"
