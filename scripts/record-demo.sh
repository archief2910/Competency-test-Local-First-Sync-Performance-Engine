#!/usr/bin/env bash
# SoB 2026 - Nostream - Project 1 competency test - Linux/macOS/WSL demo recorder.
#
# Produces two artefacts in results/:
#   - demo-session.txt  (plain text transcript, always)
#   - demo.cast         (asciinema v2 JSON, only if `asciinema` is installed)
#
# Install asciinema (optional):
#   Ubuntu/Debian : sudo apt install asciinema
#   macOS (brew)  : brew install asciinema
#   pip           : pipx install asciinema
#
# Then replay with:   asciinema play results/demo.cast
# Or upload with:     asciinema upload results/demo.cast

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$here"
mkdir -p results
transcript="results/demo-session.txt"
cast="results/demo.cast"

phases() {
  printf '================================================================================\n'
  printf ' SoB 2026 - Nostream - Project 1 competency test - recorded demo session\n'
  printf '================================================================================\n'
  printf ' host       : %s\n' "$(hostname)"
  printf ' os         : %s\n' "$(uname -sr)"
  printf ' node       : %s\n' "$(node --version)"
  printf ' npm        : %s\n' "$(npm --version)"
  printf ' captured   : %s\n' "$(date -Is)"
  printf '================================================================================\n\n'

  printf '>>> [1/4] typecheck  (tsc --noEmit)\n'
  npm run typecheck
  echo

  printf '>>> [2/4] selftest  (13 pure-function assertions)\n'
  npm run selftest
  echo

  printf '>>> [3/4] loopback  (bind -> send -> self-receive -> parse)\n'
  npm run loopback
  echo

  printf '>>> [4/4] two-process  (sender + receiver on the LAN)\n'
  bash scripts/capture-two-process.sh
  echo

  printf '================================================================================\n'
  printf ' DEMO SESSION COMPLETE - all four phases exited 0.\n'
  printf '================================================================================\n'
}

# Always write the plain-text transcript with `script`.
phases 2>&1 | tee "$transcript"

# Optionally write the asciinema .cast.
if command -v asciinema >/dev/null 2>&1; then
  echo
  echo "[record-demo] asciinema detected - recording $cast"
  asciinema rec --overwrite "$cast" --command "bash -c '$(declare -f phases); phases'"
  echo "[record-demo] replay locally with:  asciinema play $cast"
else
  echo
  echo "[record-demo] asciinema not installed - only plain-text transcript written."
  echo "              install with:  pipx install asciinema  (or  brew install asciinema)"
fi
