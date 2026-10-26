#!/usr/bin/env bash
# Router-only step 4, one run on testnet-l1, from the repository root: the conductor re-run on the
# candidate with the routing file. Both contracts are adopted and nothing is sent; it writes `routing`.
# $1 is the rates file, $2 the routing file.
set -euo pipefail
I=implementations-plan/lifi-routing/lessons/v6/intent.json
bun packages/bridge-core/scripts/live-intent.ts verify "$I"
bun run --cwd packages/bridge-core deploy:generation deploy --router-only \
	--config ../../apps/tools/public/testnet-bridge.candidate.json --rates "$1" --routing "$2"
