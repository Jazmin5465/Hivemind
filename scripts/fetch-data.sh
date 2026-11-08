#!/usr/bin/env bash
# Fetch EOG datasets into the gitignored data/ folder.
#   history/<folder>  -> data/eog/<folder>
#   test/             -> data/test/            (once EOG adds it before judging)
# Usage: scripts/fetch-data.sh [--test-only]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO_URL="${EOG_REPO_URL:-https://github.com/nihaal419/HackUTD-ZeroDay.git}"
CACHE="$ROOT/data/.eog-repo"
mkdir -p "$ROOT/data/eog"

if [ -d "$CACHE/.git" ]; then
  git -C "$CACHE" fetch --depth 1 origin HEAD -q
  git -C "$CACHE" reset --hard FETCH_HEAD -q
else
  rm -rf "$CACHE"
  git clone --depth 1 --filter=blob:none --sparse "$REPO_URL" "$CACHE" -q
fi
git -C "$CACHE" sparse-checkout set history test

if [ "${1:-}" != "--test-only" ]; then
  for d in "$CACHE"/history/*/; do
    name="$(basename "$d")"
    rm -rf "$ROOT/data/eog/$name"
    cp -R "$d" "$ROOT/data/eog/$name"
    echo "history/$name -> data/eog/$name"
  done
fi

if [ -d "$CACHE/test" ] && [ -f "$CACHE/test/telemetry.csv" ]; then
  rm -rf "$ROOT/data/test"
  cp -R "$CACHE/test" "$ROOT/data/test"
  echo "test/ -> data/test"
else
  echo "test/ not published yet (no test/telemetry.csv upstream)"
fi
