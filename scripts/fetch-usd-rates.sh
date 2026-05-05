#!/usr/bin/env bash
# Fetch monthly USD-base exchange-rate snapshots from Frankfurter
# (api.frankfurter.dev) for the 1st of every month from START to END (inclusive).
#
# Idempotent: existing files are skipped, only missing months are downloaded —
# safe to re-run monthly to append new snapshots.
#
# Each response is saved as src-tauri/seed/exchange-rates/usd/YYYY-MM-01.json.
#
# Usage:
#   ./scripts/fetch-usd-rates.sh                       # 2025-01 .. current month
#   ./scripts/fetch-usd-rates.sh 2000-01 2026-05       # custom range (e.g. backfill)
#   PARALLEL=8 ./scripts/fetch-usd-rates.sh            # tune concurrency (default 16)
set -euo pipefail

START="${1:-2025-01}"
END="${2:-$(date +%Y-%m)}"
PARALLEL="${PARALLEL:-16}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="$ROOT/src-tauri/seed/exchange-rates/usd"
mkdir -p "$OUT_DIR"

# Generate the list of YYYY-MM-01 dates between START and END (inclusive).
gen_dates() {
  local sy=${START%-*}; local sm=${START#*-}
  local ey=${END%-*};   local em=${END#*-}
  local y=$((10#$sy)) m=$((10#$sm))
  local Y=$((10#$ey)) M=$((10#$em))
  while (( y < Y || (y == Y && m <= M) )); do
    printf "%04d-%02d-01\n" "$y" "$m"
    m=$((m + 1)); if (( m > 12 )); then m=1; y=$((y + 1)); fi
  done
}

fetch_one() {
  local date="$1"
  local out="$OUT_DIR/${date}.json"
  if [[ -s "$out" ]]; then
    echo "skip $date"
    return 0
  fi

  # Try the exact date first.
  local raw
  raw=$(curl -sS --fail --retry 3 --retry-delay 2 \
    "https://api.frankfurter.dev/v2/rates?from=${date}&to=${date}&base=USD") || {
    echo "FAIL $date" >&2
    return 1
  }

  # If the source has no data for that exact day (e.g. holiday), widen the
  # window 7 days backwards and take the latest available date.
  local count
  count=$(printf '%s' "$raw" | jq 'length')
  if [[ "$count" == "0" ]]; then
    local back
    back=$(python3 -c "from datetime import date,timedelta; print((date.fromisoformat('$date')-timedelta(days=7)).isoformat())")
    raw=$(curl -sS --fail --retry 3 --retry-delay 2 \
      "https://api.frankfurter.dev/v2/rates?from=${back}&to=${date}&base=USD") || {
      echo "FAIL $date (widened)" >&2
      return 1
    }
    count=$(printf '%s' "$raw" | jq 'length')
    if [[ "$count" == "0" ]]; then
      echo "FAIL $date (no data in 7-day window)" >&2
      return 1
    fi
  fi

  # Reshape array → compact object, sort keys for stable diffs, tag source.
  printf '%s' "$raw" | jq --sort-keys '
    group_by(.date) | last as $g
    | {
        base:   $g[0].base,
        date:   $g[0].date,
        source: "api.frankfurter.dev/v2/rates",
        rates:  ($g | map({(.quote): .rate}) | add)
      }
  ' > "$out.tmp"
  mv "$out.tmp" "$out"
  echo "got  $date"
}
export -f fetch_one
export OUT_DIR

before=$(find "$OUT_DIR" -maxdepth 1 -name '*.json' -type f | wc -l | tr -d ' ')

gen_dates | xargs -n 1 -P "$PARALLEL" -I {} bash -c 'fetch_one "$@"' _ {}

after=$(find "$OUT_DIR" -maxdepth 1 -name '*.json' -type f | wc -l | tr -d ' ')
added=$(( after - before ))
size=$(du -sh "$OUT_DIR" | awk '{print $1}')

echo
echo "range:  $START .. $END"
echo "before: $before files"
echo "after:  $after files (+$added)"
echo "size:   $size"
echo "out:    $OUT_DIR"
