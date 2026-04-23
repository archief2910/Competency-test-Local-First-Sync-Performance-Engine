#!/usr/bin/env bash
# SoB 2026 · Nostream · Project 1 competency test — two-process capture (Linux/macOS/WSL)
# Runs sender + receiver on the same LAN with a shared session tag; writes results/two-process-run.txt.

set -euo pipefail

COUNT=${COUNT:-5}
INTERVAL_MS=${INTERVAL_MS:-500}
RECEIVER_DEADLINE_MS=${RECEIVER_DEADLINE_MS:-6000}
SESSION=${SESSION:-poc-$RANDOM$RANDOM}

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$here"
mkdir -p results
rx="results/two-process-receiver.log"
tx="results/two-process-sender.log"
out="results/two-process-run.txt"
rm -f "$rx" "$tx" "$out"

echo "[capture] session=$SESSION  count=$COUNT  interval=${INTERVAL_MS}ms  deadline=${RECEIVER_DEADLINE_MS}ms"

npx tsx poc-multicast.ts --role=receiver --session-tag="$SESSION" --deadline-ms="$RECEIVER_DEADLINE_MS" \
    >"$rx" 2>&1 &
rx_pid=$!

sleep 1.5

npx tsx poc-multicast.ts --role=sender --session-tag="$SESSION" --count="$COUNT" --interval-ms="$INTERVAL_MS" \
    >"$tx" 2>&1

wait "$rx_pid" || true

{
  printf '================================================================================\n'
  printf ' SoB 2026 - Nostream - Project 1 competency test - two-process run (bash)\n'
  printf '================================================================================\n'
  printf ' host      : %s\n' "$(hostname)"
  printf ' os        : %s\n' "$(uname -sr)"
  printf ' node      : %s\n' "$(node --version)"
  printf ' session   : %s\n' "$SESSION"
  printf ' captured  : %s\n' "$(date -Is)"
  printf ' params    : count=%s  interval=%sms  receiver-deadline=%sms\n\n' "$COUNT" "$INTERVAL_MS" "$RECEIVER_DEADLINE_MS"

  printf -- '--------------------------------------------------------------------------------\n'
  printf ' RECEIVER  (terminal 1)  --  npx tsx poc-multicast.ts --role=receiver --session-tag=%s --deadline-ms=%s\n' "$SESSION" "$RECEIVER_DEADLINE_MS"
  printf -- '--------------------------------------------------------------------------------\n\n'
  cat "$rx"

  printf '\n--------------------------------------------------------------------------------\n'
  printf ' SENDER    (terminal 2)  --  npx tsx poc-multicast.ts --role=sender --session-tag=%s --count=%s --interval-ms=%s\n' "$SESSION" "$COUNT" "$INTERVAL_MS"
  printf -- '--------------------------------------------------------------------------------\n\n'
  cat "$tx"
} > "$out"

rm -f "$rx" "$tx"

echo
echo "=== results/two-process-run.txt ==="
cat "$out"
