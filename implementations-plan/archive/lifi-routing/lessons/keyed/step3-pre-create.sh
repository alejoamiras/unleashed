#!/usr/bin/env bash
# Router-only step 3, one run on testnet-generation, from the repository root: Circle USDC and WETH
# pre-created and hub-registered into the candidate as real tokens, each behind `live-intent verify`.
# A re-run adopts a landed portal or registration, so only the readback lag is retried.
set -euo pipefail
I=implementations-plan/lifi-routing/lessons/v6/intent.json
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
retry g pre-create --token 0x1c7d4b196cb0c7b01d743fbc6116a902379c7238 --canonical
retry g pre-create --token 0xfff9976782d46cc05630d1f6ebab18b2324d6b14 --canonical
