#!/usr/bin/env bash
# with-window-env.sh <template> <cmd> [args…]: runs one live step the way env-exec would, from the stash
# stash-window-env.sh wrote. The command gets only the names its template lists, env-exec's keyed PATH and
# no stdin; its output goes through env-exec's own masker with every stashed value, so a step that echoes
# the keyed node URL prints [masked:…]. Values are read from the stash, never from argv.
set -euo pipefail
f=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/aztec-6-stable-window.env
tpl=$1
shift
if [ ! -r "$f" ] || [ ! -O "$f" ] || [ "$(stat -c %a "$f")" != 600 ]; then
	echo "no private stash at $f" >&2
	exit 1
fi
# shellcheck disable=SC2034 # read by the sourced env-exec, which then skips its main
KEYED_LIB=1
# shellcheck source=/dev/null
. "$(command -v env-exec)"
mapfile -t want < <(grep -E '^[A-Z][A-Z0-9_]*=' "$tpl" | cut -d= -f1)
if [ "${#want[@]}" -eq 0 ]; then
	echo "$tpl names no variables" >&2
	exit 1
fi
all=()
while IFS= read -r line; do
	keyed_check_name "${line%%=*}"
	all+=("${line%%=*}")
	declare "${line%%=*}=${line#*=}"
done < "$f"
for n in "${want[@]}"; do
	if [ -z "${!n:-}" ]; then
		echo "$n (from $tpl) is not in the stash" >&2
		exit 1
	fi
done
path=$(keyed_run_path)
set +e +o pipefail
(
	for n in "${want[@]}"; do export "${n?}"; done
	PATH=$path exec "$@" < /dev/null
) 2>&1 | (
	for n in "${all[@]}"; do export "${n?}"; done
	exec /usr/bin/perl -e "$KEYED_MASKER" -- "${all[@]}"
)
codes=("${PIPESTATUS[@]}")
if [ "${codes[1]}" -ne 0 ]; then
	echo "masker failed (${codes[1]}); command exit ${codes[0]}" >&2
	exit 125
fi
exit "${codes[0]}"
