#!/usr/bin/env bash
# Step 6, one run on testnet-l1, from the repository root on the retired-router manifest: the FPC gate,
# then the fueled validator through the deposit router (one public and one private self-paying claim),
# each signing group behind `live-intent verify`. No retry, so a failure stops for a reading.
# The intent is a fresh router-only one with no pre-creation: it refuses any journal step.
set -euo pipefail
I=implementations-plan/lifi-routing/lessons/v6-arc5/intent-gates.json
M=apps/tools/public/testnet-bridge.json
export FUEL_SLICE_UNITS=1500000
bun packages/bridge-core/scripts/check-fpc-version.ts
bun packages/bridge-core/scripts/live-intent.ts verify "$I"
PRIVATE_RUNS=1 bun packages/bridge-core/scripts/fuel-testnet.ts --config "$M"
bun packages/bridge-core/scripts/live-intent.ts verify "$I"
