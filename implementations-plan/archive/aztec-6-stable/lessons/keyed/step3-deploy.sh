#!/usr/bin/env bash
# Phase 9 step 3, one keyed run on testnet-generation, from the repository root: the dry run, the
# generation with USDC and USDT, then EURC and GBPC pre-created unregistered. Each signing command runs
# behind `live-intent verify`. A re-run adopts a landed factory, hub or portal, but not a swap target or
# router whose receipt read failed before its journal line, so only the runbook's read-after-receipt lag
# is retried (four attempts, a minute apart); any other failure stops for a reading.
set -euo pipefail
I=implementations-plan/aztec-6-stable/lessons/intent.json
export SKIP_POOL_SEED=1
export SEED_TOKENS=0x8648424f0eae2368555d080c948b622d992651fc,0x8badb545be5d79f28d516844bf1713cc7a3f238f
v() { bun packages/bridge-core/scripts/live-intent.ts verify "$I"; }
g() { bun run --cwd packages/bridge-core deploy:generation "$@"; }
retry() {
	local a out
	for a in 1 2 3 4; do
		v
		if out=$("$@" 2>&1); then
			printf '%s\n' "$out"
			return 0
		fi
		printf '%s\n' "$out"
		# A here-string past the pipe buffer spills to an unmasked temp file, so match in the shell.
		case $out in
			*"returned no data"* | *"landed but the factory has no registration"*) ;;
			*) return 1 ;;
		esac
		echo "attempt $a hit the readback lag: $*"
		if [ "$a" -lt 4 ]; then sleep 60; fi
	done
	return 1
}
v
g deploy --dry-run
retry g deploy
retry g pre-create --no-register --token 0xc10bcb5a0519934e68b489a3a89ee28af8624d24
retry g pre-create --no-register --token 0x177ead2a677858e376941390548fcf01a6ebefca
