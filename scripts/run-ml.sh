#!/usr/bin/env bash
# Start Hadent's ML sidecar (ml/serve.py, see docs/ML_CONTRACT.md) on 127.0.0.1:8001.
#   ML_DIR   folder containing serve.py (default: <repo>/ml; Hadent's code lives on the ml-sidecar branch)
#   ML_PY    python interpreter with fastapi/uvicorn/orjson/lightgbm/pandas/numpy (default: python3)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ML_DIR="${ML_DIR:-$ROOT/ml}"
ML_PY="${ML_PY:-python3}"
if [ ! -f "$ML_DIR/serve.py" ]; then
  echo "no $ML_DIR/serve.py. Merge or check out Hadent's ml-sidecar branch, or set ML_DIR" >&2
  exit 1
fi
cd "$ML_DIR/.."
exec "$ML_PY" "$ML_DIR/serve.py"
