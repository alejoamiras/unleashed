#!/usr/bin/env bash
# Phase 10 step 1, one run on testnet-l1, from the repository root, against the promoted manifest: strict
# verify-l1 (its rebuild is the keyed PATH's forge), the deployment re-derivation, the FPC gate, the fuel
# canary with one private claim, the direct Fee Juice canary and a drip. Nothing else may build forge
# while this runs. No retry, so a failure stops for a reading.
set -euo pipefail
I=implementations-plan/aztec-6-stable/lessons/intent.json
M=apps/tools/public/testnet-bridge.json
export FUEL_SLICE_UNITS=1500000
forge --version
bun run --cwd packages/bridge-core verify:l1 --config ../../apps/tools/public/testnet-bridge.json --strict
BRIDGE_MANIFEST=public/testnet-bridge.json bun run --cwd apps/tools verify:deployments
bun packages/bridge-core/scripts/check-fpc-version.ts
bun packages/bridge-core/scripts/live-intent.ts verify "$I"
PRIVATE_RUNS=1 bun packages/bridge-core/scripts/fuel-testnet.ts --config "$M"
bun packages/bridge-core/scripts/live-intent.ts verify "$I"
bun packages/bridge-core/scripts/fee-juice-canary-testnet.ts --config "$M"
bun packages/bridge-core/scripts/drip-canary-testnet.ts
bun packages/bridge-core/scripts/live-intent.ts verify "$I"
