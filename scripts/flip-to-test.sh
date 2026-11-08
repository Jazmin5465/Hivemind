#!/usr/bin/env bash
# The judging flip, as one command:
#   scripts/flip-to-test.sh                 fetch EOG test/ -> data/test, load it as dataset "test", activate, print alerts
#   scripts/flip-to-test.sh --local         skip the fetch; use a folder already dropped into data/test by hand
#   scripts/flip-to-test.sh --drill         rehearsal: use history/mock_test_* as the stand-in for test/
#   scripts/flip-to-test.sh --folder <dir>  any dataset folder (three files), loaded as dataset "test"
# Requires the local SpacetimeDB server and the published module (scripts/setup-local.sh).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
START=$(date +%s)
MODE="${1:-fetch}"
ID="test"

case "$MODE" in
  fetch|"")
    bash scripts/fetch-data.sh --test-only
    DIR="data/test" ;;
  --local)
    DIR="data/test" ;;
  --drill)
    DIR="$(ls -d data/eog/mock_test_* 2>/dev/null | head -1 || true)"
    [ -n "$DIR" ] || { echo "no data/eog/mock_test_* (run scripts/fetch-data.sh)" >&2; exit 1; }
    ID="drill_$(basename "$DIR")" ;;
  --folder)
    DIR="${2:?usage: --folder <dir>}" ;;
  *)
    echo "unknown option $MODE" >&2; exit 2 ;;
esac

for f in network.json ops.json telemetry.csv; do
  [ -f "$DIR/$f" ] || { echo "✗ $DIR/$f missing. test/ may not be published yet: drop the three files into data/test and rerun with --local" >&2; exit 1; }
done

echo "▶ loading $DIR as dataset '$ID' and activating it"
npx tsx worker/src/cli/load.ts "$DIR" --id "$ID"
npx tsx worker/src/cli/status.ts "$ID"
echo "✓ flip complete in $(( $(date +%s) - START )) s"
