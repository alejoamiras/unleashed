#!/usr/bin/env bash
# Runs a crate's TXE suite (src/test/) against a live TXE oracle server.
#
# Architecture (discovered the hard way):
#   - aztec-nargo's built-in test runner does NOT resolve TXE oracles; they must be served by
#     @aztec-labs/txe over HTTP and passed via --oracle-resolver.
#   - The TXE server resolves DEPENDENCY contract artifacts from the crate's target/, under
#     "<dependency_package_name>-<ContractName>.json". Each crate declares its staged deps below.
#   - The Token artifact MUST be the transpiled one (@aztec-foundation/aztec-standards ships it);
#     plain `nargo compile` output is rejected ("public bytecode has not been transpiled").
#   - Long TXE calls die on nargo's default foreign-call timeout; upstream CI raises it.
#   - The server's dependency set is the committed mini-project in ../txe-server (frozen lockfile),
#     never an ad-hoc `bun add` — its transitives are part of the supply chain.
#
# Usage: scripts/run-txe-tests.sh [--crate token_bridge_hub] [nargo flags...] [-- test names...]
#
# Pass criteria are per crate: a committed `txe-manifest.txt` names every test that must pass, so a
# dropped `mod test;` or a silently skipped file cannot read as green.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"          # contracts/bridge/aztec
repo_root="$(cd "$here/../../.." && pwd)"
AZTEC_HOME="${AZTEC_HOME:-$HOME/.aztec/versions/6.0.0-rc.1}"
NARGO="$AZTEC_HOME/bin/aztec-nargo"
[ -x "$NARGO" ] || { echo "aztec-nargo not found at $NARGO" >&2; exit 1; }

crate="token_bridge_hub"
if [ "${1:-}" = "--crate" ]; then
  crate="${2:-}"; shift 2
fi
case "$crate" in
  token_bridge_hub) ;;
  *) echo "usage: $0 [--crate token_bridge_hub] [nargo flags...] [-- test names...]" >&2; exit 2 ;;
esac
# Everything before `--` is a nargo flag (with or without a value); only names after `--` filter.
nargo_flags=()
filters=()
seen_sep=0
for a in "$@"; do
  if [ "$seen_sep" = 1 ]; then filters+=("$a")
  elif [ "$a" = "--" ]; then seen_sep=1
  else nargo_flags+=("$a")
  fi
done
tb="$here/$crate"
mkdir -p "$tb/target"

# Port is per-run, not fixed: many agents share this host, and a hardcoded 8080 either collides
# with another run or — worse — silently reuses ITS server and reports results from a foreign
# oracle.
#
# Asking the kernel for a free port and releasing it leaves a window in which another process
# can take it, so retry the whole claim-and-bind rather than trusting one probe. The retry is
# what makes this safe, not the probe itself.
pick_free_port() {
  node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{const p=s.address().port;s.close(()=>console.log(p))})'
}
PORT_PINNED=1
if [ -z "${TXE_PORT:-}" ]; then
  PORT_PINNED=0
  TXE_PORT="$(pick_free_port)"
fi
TXE_PKG_DIR="$here/txe-server"
TXE_PID=""

# Tear down ONLY the server this script started. A run that reused a caller-supplied port leaves
# that server alone; `pkill -f txe` would kill another agent's oracle mid-suite.
cleanup() {
  [ -n "$TXE_PID" ] && kill "$TXE_PID" 2>/dev/null
  return 0
}
trap cleanup EXIT INT TERM

# ── 1. Stage dependency artifacts into <crate>/target/ ──────────────────────────────
# Resolved through bridge-core's declared dependency, not $repo_root/node_modules: this repo
# uses bun's isolated linker, so there is no hoisted root node_modules to look in.
TOKEN_ARTIFACT="$repo_root/packages/bridge-core/node_modules/@aztec-foundation/aztec-standards/artifacts/target/token_contract-Token.json"
[ -f "$TOKEN_ARTIFACT" ] || { echo "Token artifact missing at $TOKEN_ARTIFACT — run bun install." >&2; exit 1; }
cp "$TOKEN_ARTIFACT" "$tb/target/token_contract-Token.json"

# TXE speaks JSON-RPC and does not answer a bare GET, so `curl -sf` reports failure even once
# it is serving. Probe the TCP socket instead — the original HTTP probe never succeeded, which
# only went unnoticed because the wait loop fell through and ran the suite anyway.
txe_up() { (exec 3<>"/dev/tcp/127.0.0.1/$TXE_PORT") 2>/dev/null; }

# ── 2. Start our own TXE server ─────────────────────────────────────────────────────
if [ "$PORT_PINNED" = "1" ] && txe_up; then
  echo "reusing the TXE server already listening on :$TXE_PORT (caller-pinned)"
else
  if [ ! -f "$TXE_PKG_DIR/node_modules/@aztec-labs/txe/dest/bin/index.js" ]; then
    (cd "$TXE_PKG_DIR" && bun install --frozen-lockfile >/dev/null 2>&1) || {
      echo "txe-server install failed — run: (cd $TXE_PKG_DIR && bun install --frozen-lockfile)" >&2; exit 1; }
  fi
  # Retry the whole claim-and-bind: another process can take the port between our probe
  # releasing it and the server binding it. Only an unpinned port may be re-picked — a caller
  # who named a port gets one attempt and a clear failure.
  started=0
  for attempt in 1 2 3; do
    echo "starting TXE server on :$TXE_PORT (attempt $attempt) ..."
    # NOTE: run under NODE, not bun — native lmdb bindings crash under bun. `exec` so $! is the
    # server itself rather than a subshell that exits and orphans it.
    (cd "$TXE_PKG_DIR" && TXE_PORT="$TXE_PORT" NODE_OPTIONS="--max-old-space-size=8192" \
      exec node node_modules/@aztec-labs/txe/dest/bin/index.js > "$TXE_PKG_DIR/txe-$TXE_PORT.log" 2>&1) &
    TXE_PID=$!
    for _ in $(seq 1 60); do
      txe_up && break
      kill -0 "$TXE_PID" 2>/dev/null || break   # died early — stop waiting, read the log
      sleep 1
    done
    if txe_up && kill -0 "$TXE_PID" 2>/dev/null; then
      started=1
      break
    fi
    cleanup
    TXE_PID=""
    [ "$PORT_PINNED" = "1" ] && break
    TXE_PORT="$(pick_free_port)"
  done
  [ "$started" = "1" ] || {
    echo "TXE server never came up on :$TXE_PORT — see $TXE_PKG_DIR/txe-$TXE_PORT.log" >&2
    exit 1
  }
fi

# ── 3. Run the suite ────────────────────────────────────────────────────────────────
export NARGO_FOREIGN_CALL_TIMEOUT=1200000
cd "$tb"
# One TXE server, concurrency bounded by its store: the server's lmdb store opens with
# maxReaders 2, and nargo defaults to one test thread per core. Any thread count above the
# reader limit is a gamble — past a few dozen tests the limit is exceeded and the native binding
# aborts the whole process with an uncaught Napi::Error (four threads passed one CI run and
# aborted the next, after 35 tests). Every test still in flight then fails with "Failed calling
# external resolver", which reads like a suite-wide breakage rather than a capacity limit — and
# any bare `should_fail` test passes vacuously on that connect error. Two threads finish the hub's
# suite in a few minutes; override with TXE_TEST_THREADS only if the server gains readers.
TEST_THREADS="${TXE_TEST_THREADS:-2}"
# Not exec: that would replace this shell and skip the EXIT trap, orphaning the TXE server.
# tee, and assert a POSITIVE count afterwards: nargo exits 0 when it discovers no tests at all,
# so dropping `mod test;` would otherwise read as a clean pass.
set -o pipefail
"$NARGO" test --force --show-output --test-threads "$TEST_THREADS" --oracle-resolver "http://127.0.0.1:$TXE_PORT" "${nargo_flags[@]}" "${filters[@]}" \
  | tee "$tb/txe-run.log"
rc=$?
grep -qE "[1-9][0-9]* tests? passed" "$tb/txe-run.log" || {
  echo "run-txe-tests.sh: nargo reported no passing tests — is the test module still wired in?" >&2
  exit 1
}
# Named manifest: every required test must appear as passed in the log. A test-NAME filter (a
# subset run) skips this check, since a partial run is never a pass claim; flags do not. The
# manifest itself is required and must carry at least the crate's floor of names — an emptied
# manifest is not a pass criterion either.
if [ "${#filters[@]}" -eq 0 ]; then
  [ -f "$tb/txe-manifest.txt" ] || { echo "run-txe-tests.sh: $tb/txe-manifest.txt is missing" >&2; exit 1; }
  floor=40
  named=$(grep -E '^[A-Za-z_][A-Za-z0-9_]*$' "$tb/txe-manifest.txt" | sort -u | wc -l | tr -d ' ')
  if [ "$named" -lt "$floor" ]; then
    echo "run-txe-tests.sh: $tb/txe-manifest.txt names $named tests; the floor for $crate is $floor" >&2
    exit 1
  fi
  missing=0
  # Stripped once, not piped per name: under pipefail, `sed | grep -q` fails whenever grep's early
  # exit SIGPIPEs sed, which happens for a match near the top of a log larger than the pipe buffer.
  run_log="$(sed -E 's/\x1b\[[0-9;]*m//g' "$tb/txe-run.log")"
  while IFS= read -r name; do
    [ -z "$name" ] && continue
    case "$name" in \#*) continue ;; esac
    # Anchored on the module separator so a manifest entry cannot be satisfied by a longer name
    # ending in it.
    if ! grep -qE "Testing [A-Za-z0-9_:]*::${name} \.\.\. ok" <<<"$run_log"; then
      echo "run-txe-tests.sh: required test '$name' did not pass" >&2
      missing=1
    fi
  done < "$tb/txe-manifest.txt"
  [ "$missing" = "0" ] || exit 1
fi
exit "$rc"
