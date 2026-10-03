#!/usr/bin/env bash
# Runs the pinned aztec-nargo in a crate directory: scripts/nargo.sh <crate-dir> <nargo args...>
# The bridge contracts pin aztec-nr at v6.0.0-rc.1; the default toolchain on PATH may differ and fails
# with a flood of macro errors, so every local invocation goes through this wrapper.
set -euo pipefail
AZTEC_HOME="${AZTEC_HOME:-$HOME/.aztec/versions/6.0.0-rc.1}"
NARGO="$AZTEC_HOME/bin/aztec-nargo"
[ -x "$NARGO" ] || { echo "aztec-nargo not found at $NARGO — run: aztec-up install 6.0.0-rc.1" >&2; exit 1; }
crate="$1"; shift
cd "$crate"
exec "$NARGO" "$@"
