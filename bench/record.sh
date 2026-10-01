#!/usr/bin/env bash
# record.sh — record the npm registry once, for benchmarks that replay it.
#
#   ./record.sh                         # every runner, the default fixtures
#   ./record.sh -r upm,pnpm12 -f nuxt   # a subset, added to an existing recording
#   ./bench.sh --registry replay        # then benchmark against it
#
# Starts registry.ts in record mode and runs bench.sh through it, so the recording holds every
# request a timed run makes, its response and timing. Three cold rounds by default: the first
# to ask for a url meets the CDN's miss and the proxy's new connections, and replay takes the
# median of every sample of a request, so that one slow sample does not land on whichever
# manager ran first. Recording into an existing recording adds to it and keeps its start time.
# Each runner and fixture whose runs all succeeded goes in <dir>/recorded, which
# `bench.sh --registry replay` reads to record what is missing before it starts timing. A
# runner recorded at a new version drops what its older versions recorded.
#
# Options: --port <n> (default 4880), --upstream <url> (default https://registry.npmjs.org),
# --plain (http, not TLS, for a new recording), -o, --out <dir> (default BENCH_RECORDING or
# bench/recording). Others go to bench.sh.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/runners.sh"

DIR="$RECORDING"
SERVER=()
ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    -o|--out)          DIR="$2"; shift 2 ;;
    --port|--upstream) SERVER+=("$1" "$2"); shift 2 ;;
    --plain)           SERVER+=("$1"); shift ;;
    -h|--help)         sed -n '2,19p' "$HERE/record.sh" | sed 's/^# \?//'; exit 0 ;;
    *)                 ARGS+=("$1"); shift ;;
  esac
done

mkdir -p "$DIR"
DIR="$(cd "$DIR" && pwd)"
LOG="$DIR/registry.log"
trap 'registry_stop "$LOG"' EXIT
registry_start record "$DIR" "$LOG" "${SERVER[@]}" || exit 1
echo "record: $DIR on $REGISTRY_ORIGIN"

# The gate counts back from the recording's start, as it will in every replay.
BENCH_AGE_FROM="$(recording_start "$DIR")"
export BENCH_AGE_FROM REGISTRY_PER_RUNNER=1 REGISTRY_CA
OUT="$DIR/record-$(date -u +%Y%m%dT%H%M%SZ).jsonl"
"$HERE/bench.sh" --registry "$REGISTRY_ORIGIN/" --cold 3 --warm 1 --repeat 1 --no-chart -o "$OUT" "${ARGS[@]}"

registry_stop "$LOG"
node "$HERE/registry.ts" settle "$DIR" "$OUT"
