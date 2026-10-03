#!/usr/bin/env bash
# Compile + AVM-transpile the deployable L2 bridge contracts.
#
# These contracts pin aztec-nr at the v6.0.0-rc.1 git tag, which needs the matching
# 6.0.0-rc.1 toolchain. The `aztec` CLI + `bb` (the AVM transpiler) live under
# node_modules/.bin; nargo is exposed as `aztec-nargo` in bin/ (5.0 renamed the bundled
# bare binaries to aztec-* on PATH). Plain `nargo compile` produces a NON-transpiled
# artifact that aztec.js loadContractArtifact rejects ("public bytecode has not been
# transpiled"); `aztec compile` does nargo + transpile + VKs. Output: the postprocessed
# target/*.json (the deployable artifact).
#
#   compile.sh            rebuild every crate's artifact in place
#   compile.sh --check    rebuild, then require each crate's DERIVED class id to equal the
#                         committed artifact's; the committed bytes are restored afterwards
#                         either way (the check must not dirty the tree). Exit 1 on any drift.
#   compile.sh [--check] <crate>...   restrict to the named crates
set -euo pipefail

AZTEC_HOME="${AZTEC_HOME:-$HOME/.aztec/versions/6.0.0-rc.1}"
AZTEC="$AZTEC_HOME/node_modules/.bin/aztec"
[ -x "$AZTEC" ] || { echo "6.0.0-rc.1 aztec CLI not found at $AZTEC — run: aztec-up install 6.0.0-rc.1" >&2; exit 1; }

export PATH="$AZTEC_HOME/bin:$AZTEC_HOME/node_modules/.bin:$PATH"
export NARGO="$AZTEC_HOME/bin/aztec-nargo"
export BB="$AZTEC_HOME/node_modules/.bin/bb"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "$here/../.." && pwd)"
bridge_core="$(cd "$here/../../../packages/bridge-core" && pwd)"
class_id() { (cd "$bridge_core" && bun scripts/noir-class-id.ts "$1"); }

check=0
crates=()
for arg in "$@"; do
	case "$arg" in
		--check) check=1 ;;
		*) crates+=("$arg") ;;
	esac
done
[ ${#crates[@]} -gt 0 ] || crates=(token_bridge_hub keystone)

drift=0
for c in "${crates[@]}"; do
	echo "=== aztec compile $c ==="
	committed=""
	if [ "$check" = 1 ]; then
		# `aztec compile` rebuilds only when a source is newer than the OLDEST target/*.json — and
		# target/ also holds ignored files (the TXE runner stages a Token artifact there), so every
		# JSON is moved aside to force the build. Only the git-tracked ones are compared; all are
		# restored afterwards.
		committed="$(mktemp -d)"
		tracked="$(cd "$here/$c" && git ls-files -- target | xargs -r -n1 basename)"
		mv "$here/$c"/target/*.json "$committed/" 2>/dev/null || true
		# Whatever fails below, the committed bytes go back where they were.
		trap 'rm -f "$here/$c"/target/*.json; mv -f "$committed"/*.json "$here/$c"/target/ 2>/dev/null; rm -rf "$committed"' EXIT
	fi
	(cd "$here/$c" && "$AZTEC" compile)
	# `aztec compile` embeds absolute source paths (this machine's repo root + the ~/.aztec and
	# ~/nargo dependency caches) in the artifact's debug file_map. They are not load-bearing, but
	# the artifact is committed (CI has no nargo), so leaving them leaks the contributor's home-dir
	# layout and trips scripts/check-no-local-paths.sh. Rewrite to repo-relative so the committed artifact
	# is identical regardless of which machine built it.
	perl -i -pe "s{\Q$repo_root\E/}{}g; s{\Q$HOME\E/}{}g" "$here/$c"/target/*.json
	if [ "$check" = 1 ]; then
		[ -n "$tracked" ] || { echo "✖ $c: no committed artifact to compare against" >&2; drift=1; }
		for name in $tracked; do
			was="$committed/$name"
			fresh="$here/$c/target/$name"
			# Only a contract crate has a class id to bind; decided from the manifest, never from the
			# artifact under test (a truncated artifact must not skip its own check).
			grep -qE '^type *= *"contract"' "$here/$c/Nargo.toml" || { echo "· $c: not a contract crate, nothing to bind"; continue; }
			if [ ! -f "$fresh" ]; then
				echo "✖ $c: the source no longer produces $name" >&2
				drift=1
				continue
			fi
			want="$(class_id "$was")"
			got="$(class_id "$fresh")"
			if [ "$want" = "$got" ]; then
				echo "✔ $c: class id $got matches the committed artifact"
			else
				echo "✖ $c: class id drift — committed $want, source compiles to $got" >&2
				drift=1
			fi
		done
		# A renamed contract's fresh JSON must not survive beside the restored set.
		rm -f "$here/$c"/target/*.json
		mv -f "$committed"/*.json "$here/$c"/target/ 2>/dev/null || true
		rm -rf "$committed"
		trap - EXIT
	fi
done
if [ "$check" = 1 ]; then
	[ "$drift" = 0 ] && echo "✅ committed artifacts match their sources (class ids)" || exit 1
else
	echo "✅ transpiled + path-scrubbed artifacts in */target/*.json"
fi
