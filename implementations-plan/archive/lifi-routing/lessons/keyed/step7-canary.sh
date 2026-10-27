#!/usr/bin/env bash
# Step 7, one keyed run on testnet-rpc from the repository root: the LI.FI canary matrix on the promoted 6.0.0
# manifest, signed by the pinned canary key from its file (never the template), between two `live-intent
# verify`s that reconcile the canary's spend against its caps. No retry, so a failure stops for a reading.
set -euo pipefail
I=implementations-plan/lifi-routing/lessons/v6-arc5/intent-gates.json
CANARY_PRIVATE_KEY=$(cat "$HOME/.cache/unleashed-canary/testnet.key")
export CANARY_PRIVATE_KEY
bun packages/bridge-core/scripts/live-intent.ts verify "$I"
bun packages/bridge-core/scripts/lifi-canary-testnet.ts --config apps/tools/public/testnet-bridge.json
bun packages/bridge-core/scripts/live-intent.ts verify "$I"
