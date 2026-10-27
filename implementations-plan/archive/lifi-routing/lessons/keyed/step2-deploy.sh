#!/usr/bin/env bash
# Router-only step 2, one run on testnet-l1, from the repository root: the swapper, its rates and
# inventory, the router, behind `live-intent verify`. A re-run adopts a journalled contract whose code
# and arguments match, so only the runbook's read-after-receipt lag is retried (four attempts, a
# minute apart); any other failure stops for a reading. $1 is the rates file.
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
retry g deploy --router-only --rates "$1"
