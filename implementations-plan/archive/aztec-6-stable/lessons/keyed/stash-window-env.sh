#!/usr/bin/env bash
# The owner-approved keyed run (template window.env.example) that stashes this window's six testnet values
# in the per-user tmpfs runtime dir, mode 0600, so the remaining live steps run unattended through
# with-window-env.sh. drop-window-env.sh removes it. Prints names only.
set -euo pipefail
umask 077
d=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}
f=$d/aztec-6-stable-window.env
names=(PRIVATE_KEY SEPOLIA_RPC_URL BRIDGE_DEPLOYER_SECRET_TESTNET DRPC_API_KEY DEPLOYER_SECRET_KEY DEPLOYER_SALT)
if [ ! -d "$d" ] || [ ! -O "$d" ] || [ "$(stat -c %a "$d")" != 700 ]; then
	echo "no private runtime dir at $d" >&2
	exit 1
fi
if [ -e "$f" ]; then
	echo "$f exists; run drop-window-env.sh first" >&2
	exit 1
fi
tmp=$(mktemp "$d/.aztec-6-stable-window.XXXXXX")
trap 'rm -f "$tmp"' EXIT
for n in "${names[@]}"; do
	if [ -z "${!n:-}" ]; then
		echo "$n is empty" >&2
		exit 1
	fi
	printf '%s=%s\n' "$n" "${!n}" >> "$tmp"
done
mv "$tmp" "$f"
trap - EXIT
echo "stashed ${#names[@]} values (${names[*]}) in $f, mode $(stat -c %a "$f")"
