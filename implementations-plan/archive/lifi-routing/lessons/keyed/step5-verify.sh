#!/usr/bin/env bash
# Router-only step 5, one run on testnet-rpc (no signer), from the repository root: strict verify-l1 on
# the candidate, the FPC gate, then the digest-recording `verify --candidate`. The intent changes, so it
# is committed before `promote`, which runs on its own: never chain the two.
set -euo pipefail
I=implementations-plan/lifi-routing/lessons/v6/intent.json
forge --version
bun run --cwd packages/bridge-core verify:l1 --config ../../apps/tools/public/testnet-bridge.candidate.json --strict
bun packages/bridge-core/scripts/check-fpc-version.ts
bun packages/bridge-core/scripts/live-intent.ts verify "$I" --candidate apps/tools/public/testnet-bridge.candidate.json
