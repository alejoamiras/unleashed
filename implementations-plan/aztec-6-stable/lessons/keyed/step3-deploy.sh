#!/usr/bin/env bash
# Phase 9 step 3, one keyed run on testnet-generation, from the repository root: the dry run, the
# generation with USDC and USDT, then EURC and GBPC pre-created unregistered. Each signing command runs
# behind `live-intent verify` and retries a lagging readback up to four times, a minute apart; the
# conductor's journal makes each re-run adopt what already landed.
set -euo pipefail
I=implementations-plan/aztec-6-stable/lessons/intent.json
export SKIP_POOL_SEED=1
export SEED_TOKENS=0x8648424f0eae2368555d080c948b622d992651fc,0x8badb545be5d79f28d516844bf1713cc7a3f238f
v() { bun packages/bridge-core/scripts/live-intent.ts verify "$I"; }
g() { bun run --cwd packages/bridge-core deploy:generation "$@"; }
retry() {
	for a in 1 2 3 4; do
		if v && "$@"; then return 0; fi
		echo "attempt $a failed: $*"
		if [ "$a" -lt 4 ]; then sleep 60; fi
	done
	return 1
}
v
g deploy --dry-run
retry g deploy
retry g pre-create --no-register --token 0xc10bcb5a0519934e68b489a3a89ee28af8624d24
retry g pre-create --no-register --token 0x177ead2a677858e376941390548fcf01a6ebefca
