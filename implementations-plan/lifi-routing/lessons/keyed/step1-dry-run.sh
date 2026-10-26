#!/usr/bin/env bash
# Router-only step 1, one run on testnet-l1, from the repository root: verify the intent, then the
# conductor's dry run (signer, identity, base manifest, rates; no broadcast). $1 is the rates file.
set -euo pipefail
I=implementations-plan/lifi-routing/lessons/v6/intent.json
bun packages/bridge-core/scripts/live-intent.ts verify "$I"
bun run --cwd packages/bridge-core deploy:generation deploy --router-only --rates "$1" --dry-run
