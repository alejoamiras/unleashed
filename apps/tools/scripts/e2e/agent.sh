#!/usr/bin/env bash
# The tools browser suite, one run = one sandbox: ports → sandbox up → local tools build → test-wallet
# build → bundle assertions → playwright → reap. Parallelism is `--shard=i/n` across separate runs.
#
#   bun run e2e:tools [-- <playwright args, e.g. --shard=1/2 or specs/drip.spec.ts>]
#   bun run e2e:tools:reap        # stop every sandbox a run of THIS checkout left behind
#
# Iterating on specs: UNLEASHED_E2E_KEEP=1 leaves the sandbox and both builds alive and prints the attach
# line; UNLEASHED_E2E_ATTACH=<that state dir> reuses them (UNLEASHED_E2E_REBUILD=1 to rebuild the two apps).
# Every process this script starts is its own process group; the trap kills exactly those groups.
set -euo pipefail

cd "$(dirname "$0")/../.."
APP_DIR=$(pwd)

# Orphan recovery by OWNERSHIP: only the pgids this checkout's runs wrote to their pid files — never
# a name match, which would take down another agent's network on the same host.
if [ "${1:-}" = "reap" ]; then
  found=0
  for pidfile in "$APP_DIR"/.e2e-state/*/sandbox.pid; do
    [ -f "$pidfile" ] || continue
    pgid=$(cat "$pidfile")
    # A number alone is not ownership: the kernel recycles pids, so the group's leader must still be
    # the sandbox command this checkout started, or the file is stale and only gets removed.
    if [ -n "$pgid" ] && kill -0 -- "-$pgid" 2>/dev/null && ps -o args= -p "$pgid" 2>/dev/null | grep -q 'sandbox:up'; then
      found=1
      echo "[e2e:tools] reaping sandbox pgid $pgid ($(dirname "$pidfile"))"
      kill -TERM -- "-$pgid" 2>/dev/null || true
      for _ in $(seq 1 60); do kill -0 -- "-$pgid" 2>/dev/null || break; sleep 1; done
      kill -KILL -- "-$pgid" 2>/dev/null || true
    fi
    rm -f "$pidfile"
    # The run's browser ports: ports.json names the owner its rows were claimed under.
    statedir=$(dirname "$pidfile")
    if [ -f "$statedir/ports.json" ]; then
      bun scripts/e2e/resolve-ports.ts --release "$statedir" 2>/dev/null || true
    fi
  done
  [ "$found" = 1 ] || echo "[e2e:tools] nothing to reap"
  exit 0
fi
RUN_ID="tools-e2e-$$-$(date +%s | tail -c 6)"
STATE_DIR="${UNLEASHED_E2E_ATTACH:-${UNLEASHED_E2E_STATE_DIR:-$APP_DIR/.e2e-state/$RUN_ID}}"
mkdir -p "$STATE_DIR"
ARTIFACTS="$STATE_DIR/sandbox"
TOOLS_DIST="$STATE_DIR/tools-dist"
WALLET_DIST="$STATE_DIR/wallet-dist"
LOG="$STATE_DIR/sandbox.log"
SANDBOX_PID=""

log() { echo "[e2e:tools] $*"; }

# shellcheck disable=SC2317,SC2329  # invoked by the EXIT trap; shellcheck before 0.11 calls it SC2317
reap() {
  if [ -n "$SANDBOX_PID" ] && kill -0 "$SANDBOX_PID" 2>/dev/null; then
    if [ "${UNLEASHED_E2E_KEEP:-}" = "1" ]; then
      log "sandbox kept (pgid $SANDBOX_PID) — attach with: UNLEASHED_E2E_ATTACH=$STATE_DIR bun run e2e:tools -- <args>; stop with: kill -TERM -- -$SANDBOX_PID"
      return
    fi
    log "stopping sandbox (pgid $SANDBOX_PID)"
    kill -TERM -- "-$SANDBOX_PID" 2>/dev/null || true
    for _ in $(seq 1 60); do kill -0 "$SANDBOX_PID" 2>/dev/null || break; sleep 1; done
    kill -KILL -- "-$SANDBOX_PID" 2>/dev/null || true
  fi
  # A pid file that outlives its group would let a later `reap` mistake a recycled pgid for ours —
  # ours alone: an attached run never booted the sandbox it used and leaves the keeper's file be.
  if [ -n "$SANDBOX_PID" ] && [ "${UNLEASHED_E2E_KEEP:-}" != "1" ]; then rm -f "$STATE_DIR/sandbox.pid"; fi
  # The browser ports' registry rows belong to this run alone; a kept run keeps them claimed.
  if [ "${UNLEASHED_E2E_KEEP:-}" != "1" ] && [ -z "${UNLEASHED_E2E_ATTACH:-}" ] && [ -f "$STATE_DIR/ports.json" ]; then
    bun scripts/e2e/resolve-ports.ts --release "$STATE_DIR" 2>/dev/null || true
  fi
}
trap reap EXIT

boot_sandbox() {
  log "booting the sandbox (log: $LOG)"
  setsid bun run --cwd ../../packages/bridge-core sandbox:up --artifacts "$ARTIFACTS" >"$LOG" 2>&1 &
  SANDBOX_PID=$!
  echo "$SANDBOX_PID" >"$STATE_DIR/sandbox.pid"
  for _ in $(seq 1 600); do
    if [ -f "$ARTIFACTS/handle.json" ] && grep -q "sandbox up" "$LOG"; then break; fi
    if ! kill -0 "$SANDBOX_PID" 2>/dev/null; then log "FATAL: the sandbox died while booting — see $LOG"; tail -40 "$LOG" >&2; exit 2; fi
    sleep 2
  done
  [ -f "$ARTIFACTS/handle.json" ] || { log "FATAL: sandbox did not come up in 20 min"; exit 2; }
}

attach_sandbox() {
  [ -f "$ARTIFACTS/handle.json" ] || { log "FATAL: $ARTIFACTS/handle.json missing — nothing to attach to"; exit 2; }
  local node
  node=$(jq -r .nodeUrl "$ARTIFACTS/handle.json")
  curl -sf -X POST -H 'content-type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"node_getNodeInfo","params":[]}' "$node" >/dev/null \
    || { log "FATAL: the kept sandbox at $node does not answer — start a fresh run"; exit 2; }
  log "attached to the kept sandbox at $node"
}

build_apps() {
  log "building tools (local target) → $TOOLS_DIST"
  UNLEASHED_SANDBOX_ARTIFACTS="$ARTIFACTS" UNLEASHED_TOOLS_WEB_WALLETS="$WEB_WALLETS" \
    bun run build:local -- --outDir "$TOOLS_DIST" >"$STATE_DIR/build-tools.log" 2>&1
  # The same inputs as the build: the wallet origins are part of the target's connect-src.
  UNLEASHED_SANDBOX_ARTIFACTS="$ARTIFACTS" UNLEASHED_TOOLS_WEB_WALLETS="$WEB_WALLETS" \
    bun run verify:build-target local --dist "$TOOLS_DIST"
  grep -rqF -- "$NODE_URL" "$TOOLS_DIST/assets" || { log "FATAL: the tools bundle does not name the node $NODE_URL"; exit 2; }
  for url in "$WALLET_ORIGIN_PLAIN/?profile=plain" "$WALLET_ORIGIN_SELFPAY/?profile=selfpay" "$WALLET_ORIGIN_FULL/?profile=full"; do
    grep -rqF -- "$url" "$TOOLS_DIST/assets" || { log "FATAL: the tools bundle does not list the test wallet at $url"; exit 2; }
  done

  log "building the test wallet → $WALLET_DIST"
  UNLEASHED_SANDBOX_ARTIFACTS="$ARTIFACTS" UNLEASHED_TOOLS_ORIGIN="$TOOLS_ORIGIN" UNLEASHED_TEST_WALLET_OUT_DIR="$WALLET_DIST" \
    bun run build:test-wallet >"$STATE_DIR/build-wallet.log" 2>&1
  grep -rqF -- "$NODE_URL" "$WALLET_DIST/assets" || { log "FATAL: the wallet bundle does not name the node $NODE_URL"; exit 2; }
}

if [ -n "${UNLEASHED_E2E_ATTACH:-}" ]; then
  [ -f "$STATE_DIR/ports.json" ] || { log "FATAL: $STATE_DIR/ports.json missing — nothing to attach to"; exit 2; }
else
  log "resolving ports"
  bun scripts/e2e/resolve-ports.ts "$STATE_DIR" "$RUN_ID" "$$"
fi
TOOLS_PORT=$(jq -r .tools "$STATE_DIR/ports.json")
WALLET_PORT_PLAIN=$(jq -r .walletPlain "$STATE_DIR/ports.json")
WALLET_PORT_SELFPAY=$(jq -r .walletSelfpay "$STATE_DIR/ports.json")
WALLET_PORT_FULL=$(jq -r .walletFull "$STATE_DIR/ports.json")
case "$WALLET_PORT_PLAIN$WALLET_PORT_SELFPAY$WALLET_PORT_FULL" in
  *null*) log "FATAL: $STATE_DIR/ports.json predates the per-profile wallet ports — start a fresh run"; exit 2 ;;
esac
TOOLS_ORIGIN="http://127.0.0.1:$TOOLS_PORT"
# One origin per profile: the SDK's discovery probe accepts any message from a wallet's ORIGIN, so
# same-origin profiles cross-talk and the slowest frame is never listed.
WALLET_ORIGIN_PLAIN="http://127.0.0.1:$WALLET_PORT_PLAIN"
WALLET_ORIGIN_SELFPAY="http://127.0.0.1:$WALLET_PORT_SELFPAY"
WALLET_ORIGIN_FULL="http://127.0.0.1:$WALLET_PORT_FULL"
WEB_WALLETS="$WALLET_ORIGIN_PLAIN/?profile=plain,$WALLET_ORIGIN_SELFPAY/?profile=selfpay,$WALLET_ORIGIN_FULL/?profile=full"

if [ -n "${UNLEASHED_E2E_ATTACH:-}" ]; then attach_sandbox; else boot_sandbox; fi
NODE_URL=$(jq -r .nodeUrl "$ARTIFACTS/handle.json")
log "sandbox up — node $NODE_URL"

if [ -z "${UNLEASHED_E2E_ATTACH:-}" ] || [ "${UNLEASHED_E2E_REBUILD:-}" = "1" ] || [ ! -f "$TOOLS_DIST/build.json" ]; then
  build_apps
else
  log "reusing the builds in $STATE_DIR"
fi

log "running playwright ($*)"
set +e
UNLEASHED_SANDBOX_ARTIFACTS="$ARTIFACTS" UNLEASHED_TOOLS_PORT="$TOOLS_PORT" \
UNLEASHED_TEST_WALLET_PORT_PLAIN="$WALLET_PORT_PLAIN" UNLEASHED_TEST_WALLET_PORT_SELFPAY="$WALLET_PORT_SELFPAY" UNLEASHED_TEST_WALLET_PORT_FULL="$WALLET_PORT_FULL" \
UNLEASHED_TOOLS_DIST="$TOOLS_DIST" UNLEASHED_TEST_WALLET_DIST="$WALLET_DIST" UNLEASHED_TOOLS_WEB_WALLETS="$WEB_WALLETS" UNLEASHED_E2E_STATE_DIR="$STATE_DIR" \
NODE_OPTIONS="--import $APP_DIR/tests/browser/node-json-imports.mjs ${NODE_OPTIONS:-}" \
  ./node_modules/.bin/playwright test --config tests/browser/playwright.config.ts "$@"
STATUS=$?
set -e
log "playwright exit $STATUS (state in $STATE_DIR)"
exit $STATUS
