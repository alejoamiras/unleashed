#!/usr/bin/env bash
# Removes the stash stash-window-env.sh wrote. The runtime dir is tmpfs, so unlinking it frees the values.
set -euo pipefail
f=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/aztec-6-stable-window.env
if [ -e "$f" ]; then
	rm -f -- "$f"
	echo "dropped $f"
else
	echo "no stash at $f"
fi
if [ -e "$f" ]; then
	echo "$f still exists" >&2
	exit 1
fi
