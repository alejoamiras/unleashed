#!/usr/bin/env bash
# Sole-consumer invariant for the recipient-commitment property: the bridge contract must have
# EXACTLY its named `consume_l1_to_l2_message` call sites — three for the token_bridge_hub
# (claim_public, claim_private, and the factory's `register` message in `_bind`, consumed from
# the bound l1_factory with a constant secret) — and
# claim_private must (a) NOT take a raw secret parameter and (b) DERIVE its consumption secret via a
# `derive_claim_secret(...)` CALL inside its own body. Any of: a stray consume site, a raw-secret
# param, or a private path that consumes without deriving, silently reintroduces the F-007 bearer
# property. A static tripwire: the circuit cannot be TXE-tested for this.
#
# The parameter list + function body are analysed on a NEWLINE-FLATTENED copy of the source: the
# real `claim_private(` signature spans multiple lines and a line-oriented grep silently matches
# nothing. Consume sites are counted as occurrences across every non-test source file of the crate,
# not as lines of one file. Run `check-sole-consumer.sh --self-test` to verify the guard actually
# rejects crafted regressions.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Drops block comments and line comments while leaving string literals alone, so a `//` or `/*`
# inside a string cannot hide live code and a commented-out shape cannot pass for a live one. One
# alternation, string literal first, so a comment opener inside a string is never seen as one.
strip_comments() {
	perl -0pe 's{("(?:[^"\\]|\\.)*")|/\*.*?\*/|//[^\n]*}{defined $1 ? $1 : ""}gse'
}

# Returns 0 if the contract source at $1 (its `src/main.nr`; every sibling non-test source is
# counted too) upholds the invariant with $2 consume sites (default 2), 1 (with a reason on
# stderr) otherwise. A third site must be the register consume inside `_bind`.
check_file() {
	local main="$1"
	local expected="${2:-2}"
	[ -f "$main" ] || { echo "SOLE-CONSUMER: no such file: $main" >&2; return 1; }

	# Occurrences, not lines, across every non-test source of the crate, with line comments stripped
	# so a call site mentioned in a comment neither hides nor fakes a real one.
	local src consumers
	src="$(dirname "$main")"
	consumers=$(find "$src" -name '*.nr' -not -path '*/test/*' -exec cat {} + | strip_comments | grep -o "consume_l1_to_l2_message" | wc -l | tr -d ' ')
	if [ "$consumers" -ne "$expected" ]; then
		echo "SOLE-CONSUMER VIOLATION: expected $expected consume_l1_to_l2_message sites, found $consumers under $src" >&2
		echo "  A new consumption path can reintroduce the bearer property (F-007)." >&2
		return 1
	fi
	# Strip line comments, then flatten newlines → spaces so a multi-line signature/body is
	# analysable with one regex.
	local flat after params body
	flat=$(strip_comments < "$main" | tr '\n' ' ' | tr -s ' ')
	if [ "$expected" = 3 ]; then
		# The register consume lives in `_bind`, is keyed on the bound l1_factory (never a caller-
		# supplied sender) and uses a constant secret chosen by the publish flag, never a caller secret.
		local bind
		bind=$(printf '%s' "$flat" | sed -E 's/.*fn _bind//; s/ fn .*//')
		# The sender is the storage-bound factory, read in this body — not a parameter that happens
		# to carry the name.
		if ! printf '%s' "$bind" | grep -qE "let l1_factory = self\.storage\.l1_factory\.read\(\);"; then
			echo "SOLE-CONSUMER VIOLATION: _bind does not read l1_factory from storage" >&2
			return 1
		fi
		if ! printf '%s' "$bind" | grep -qE "let secret = if publish \{ REGISTER_SECRET \} else \{ BIND_HARNESS_SECRET \};"; then
			echo "SOLE-CONSUMER VIOLATION: _bind does not pick its secret from the two constants by the publish flag" >&2
			return 1
		fi
		if ! printf '%s' "$bind" | grep -qE "consume_l1_to_l2_message[[:space:]]*\([^,]*,[[:space:]]*\[secret\][[:space:]]*,[[:space:]]*l1_factory[[:space:]]*,"; then
			echo "SOLE-CONSUMER VIOLATION: the third consume site is not _bind consuming [secret] from l1_factory" >&2
			return 1
		fi
	fi

	if ! printf '%s' "$flat" | grep -q "fn claim_private"; then
		echo "SOLE-CONSUMER VIOLATION: no claim_private function found in $main" >&2
		return 1
	fi
	after=$(printf '%s' "$flat" | sed -E 's/.*fn claim_private//')      # everything after `fn claim_private`
	params=$(printf '%s' "$after" | sed -E 's/\).*//')                  # its parameter list (up to first `)`)
	body=$(printf '%s' "$after" | sed -E 's/ fn .*//')                  # its body (up to the next ` fn `)

	# (a) The signature must carry the recipient-committed salt and NO raw secret parameter. The legit
	#     params are {recipient, amount, claim_salt, message_leaf_index} — none contains "secret", so any
	#     "secret" substring here (secret, raw_secret, secretHash, …) is a bearer regression.
	if ! printf '%s' "$params" | grep -q "claim_salt"; then
		echo "SOLE-CONSUMER VIOLATION: claim_private no longer takes claim_salt (recipient-commitment lost)" >&2
		return 1
	fi
	if printf '%s' "$params" | grep -qi "secret"; then
		echo "SOLE-CONSUMER VIOLATION: claim_private accepts a raw secret parameter (bearer regression)" >&2
		return 1
	fi

	# (b) The consumption secret must be DERIVED via a real call (a `(` after the name — not the bare
	#     `use …::derive_claim_secret;` import), INSIDE claim_private's own body, alongside its consume.
	if ! printf '%s' "$body" | grep -qE "derive_claim_secret[[:space:]]*\("; then
		echo "SOLE-CONSUMER VIOLATION: claim_private body does not CALL derive_claim_secret(...) (import alone is not enough)" >&2
		return 1
	fi
	if ! printf '%s' "$body" | grep -q "consume_l1_to_l2_message"; then
		echo "SOLE-CONSUMER VIOLATION: claim_private body does not consume an L1→L2 message where it derives" >&2
		return 1
	fi

	# (c) Dataflow: the secret passed to consume must be the value DERIVED from
	#     derive_claim_secret, not a raw param. Catches "derive then ignore it" (`let _ = derive(...);
	#     consume(.., claim_salt, ..)`) and "consume with the raw salt". Extract the var bound to
	#     derive_claim_secret and require claim_private's consume use THAT var as its secret (2nd) arg.
	#     (aztec 5.0.1+: consume_l1_to_l2_message takes the secret as a one-element array `[secret]`, so
	#     accept EITHER `[secret]` or bare `secret` — but NOT a multi-element `[secret, X]` (the extra
	#     element would change the committed hash while a lax `\[?…\]?` regex still matched).)
	local derived_var
	derived_var=$(printf '%s' "$body" | sed -nE 's/.*let[[:space:]]+([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=[[:space:]]*derive_claim_secret[[:space:]]*\(.*/\1/p' | head -1)
	if [ -z "$derived_var" ] || [ "$derived_var" = "_" ]; then
		echo "SOLE-CONSUMER VIOLATION: claim_private does not bind the derived secret to a real variable (let X = derive_claim_secret(...))" >&2
		return 1
	fi
	if ! printf '%s' "$body" | grep -qE "consume_l1_to_l2_message[[:space:]]*\([^,]*,[[:space:]]*(\[${derived_var}\]|${derived_var})[[:space:]]*,"; then
		echo "SOLE-CONSUMER VIOLATION: claim_private consume does not use the derived secret ($derived_var) as its secret arg — bearer/dataflow bypass" >&2
		return 1
	fi

	# (d) Ban lower-level messaging/nullifier primitives: they can consume or nullify a
	#     message WITHOUT going through consume_l1_to_l2_message, bypassing (a)-(c) entirely.
	if printf '%s' "$flat" | grep -qE "process_l1_to_l2_message|push_nullifier"; then
		echo "SOLE-CONSUMER VIOLATION: a lower-level messaging/nullifier primitive is present — it can bypass consume_l1_to_l2_message" >&2
		return 1
	fi

	return 0
}

# --self-test: prove the guard passes on the real source AND rejects crafted bearer regressions.
if [ "${1:-}" = "--self-test" ]; then
	tmp=$(mktemp -d)
	trap 'rm -rf "$tmp"' EXIT
	fails=0

	check_file "$here/token_bridge_hub/src/main.nr" 3 >/dev/null 2>&1 || { echo "SELF-TEST FAIL: real hub source rejected" >&2; fails=1; }

	# Regression 1: multi-line raw-secret signature + consume-with-raw-secret, derivation import kept.
	cat >"$tmp/raw_secret.nr" <<'EOF'
use claim_secret_lib::derive_claim_secret;
fn claim_public(to: AztecAddress, amount: u128, secret: Field, message_leaf_index: Field) {
    self.context.consume_l1_to_l2_message(content_hash, secret, config.portal, message_leaf_index);
}
fn claim_private(
    recipient: AztecAddress,
    amount: u128,
    raw_secret: Field,
    message_leaf_index: Field,
) {
    self.context.consume_l1_to_l2_message(content_hash, raw_secret, config.portal, message_leaf_index);
}
EOF
	check_file "$tmp/raw_secret.nr" >/dev/null 2>&1 && { echo "SELF-TEST FAIL: multi-line raw-secret regression accepted" >&2; fails=1; }

	# Regression 2: import present but no derive CALL in the body (consume without deriving).
	cat >"$tmp/no_call.nr" <<'EOF'
use claim_secret_lib::derive_claim_secret;
fn claim_public(to: AztecAddress, amount: u128, secret: Field, message_leaf_index: Field) {
    self.context.consume_l1_to_l2_message(content_hash, secret, config.portal, message_leaf_index);
}
fn claim_private(recipient: AztecAddress, amount: u128, claim_salt: Field, message_leaf_index: Field) {
    self.context.consume_l1_to_l2_message(content_hash, claim_salt, config.portal, message_leaf_index);
}
EOF
	check_file "$tmp/no_call.nr" >/dev/null 2>&1 && { echo "SELF-TEST FAIL: import-only (no derive call) regression accepted" >&2; fails=1; }

	# Regression 3: a third consume site added.
	cat >"$tmp/three.nr" <<'EOF'
use claim_secret_lib::derive_claim_secret;
fn a() { self.context.consume_l1_to_l2_message(x); }
fn b() { self.context.consume_l1_to_l2_message(y); }
fn claim_private(recipient: AztecAddress, amount: u128, claim_salt: Field, message_leaf_index: Field) {
    let secret = derive_claim_secret(claim_salt, recipient);
    self.context.consume_l1_to_l2_message(content_hash, secret, config.portal, message_leaf_index);
}
EOF
	check_file "$tmp/three.nr" >/dev/null 2>&1 && { echo "SELF-TEST FAIL: 3-consumer regression accepted" >&2; fails=1; }

	# Regression 4: derive is CALLED but its result is discarded; consume uses the raw claim_salt (dataflow bypass).
	cat >"$tmp/dataflow.nr" <<'EOF'
use claim_secret_lib::derive_claim_secret;
fn claim_public(to: AztecAddress, amount: u128, secret: Field, message_leaf_index: Field) {
    self.context.consume_l1_to_l2_message(content_hash, secret, config.portal, message_leaf_index);
}
fn claim_private(recipient: AztecAddress, amount: u128, claim_salt: Field, message_leaf_index: Field) {
    let _ = derive_claim_secret(claim_salt, recipient);
    self.context.consume_l1_to_l2_message(content_hash, claim_salt, config.portal, message_leaf_index);
}
EOF
	check_file "$tmp/dataflow.nr" >/dev/null 2>&1 && { echo "SELF-TEST FAIL: derive-but-consume-raw-salt dataflow bypass accepted" >&2; fails=1; }

	# Regression 5: a lower-level primitive path (process_l1_to_l2_message + push_nullifier) that never
	# calls consume_l1_to_l2_message, alongside a legit-looking claim_private that passes (a)-(c).
	cat >"$tmp/lowlevel.nr" <<'EOF'
use claim_secret_lib::derive_claim_secret;
fn claim_public(to: AztecAddress, amount: u128, secret: Field, message_leaf_index: Field) {
    self.context.consume_l1_to_l2_message(content_hash, secret, config.portal, message_leaf_index);
}
fn claim_private(recipient: AztecAddress, amount: u128, claim_salt: Field, message_leaf_index: Field) {
    let secret = derive_claim_secret(claim_salt, recipient);
    self.context.consume_l1_to_l2_message(content_hash, secret, config.portal, message_leaf_index);
}
fn claim_bearer(raw: Field, leaf: Field) {
    let m = self.context.process_l1_to_l2_message(raw, leaf);
    self.context.push_nullifier(m);
}
EOF
	check_file "$tmp/lowlevel.nr" >/dev/null 2>&1 && { echo "SELF-TEST FAIL: lower-level primitive bypass accepted" >&2; fails=1; }

	# Regression 6 (hub shape): a fourth consume site beside the three named ones.
	cat >"$tmp/hub_four.nr" <<'EOF'
use claim_secret_lib::derive_claim_secret;
fn _bind(erc20: EthAddress, publish: bool) -> AztecAddress {
    let l1_factory = self.storage.l1_factory.read();
    let secret = if publish { REGISTER_SECRET } else { BIND_HARNESS_SECRET };
    self.context.consume_l1_to_l2_message(content, [secret], l1_factory, register_leaf_index);
}
fn claim_public(to: AztecAddress, amount: u128, secret: Field, message_leaf_index: Field) {
    self.context.consume_l1_to_l2_message(content_hash, [secret], portal, message_leaf_index);
}
fn claim_private(recipient: AztecAddress, amount: u128, claim_salt: Field, message_leaf_index: Field) {
    let secret = derive_claim_secret(claim_salt, recipient);
    self.context.consume_l1_to_l2_message(content_hash, [secret], portal, message_leaf_index);
}
fn claim_bearer(raw: Field, leaf: Field) {
    self.context.consume_l1_to_l2_message(content_hash, [raw], portal, leaf);
}
EOF
	check_file "$tmp/hub_four.nr" 3 >/dev/null 2>&1 && { echo "SELF-TEST FAIL: hub 4-consumer regression accepted" >&2; fails=1; }

	# Regression 8 (hub shape): the register consume is keyed on a caller-supplied sender.
	cat >"$tmp/hub_sender.nr" <<'EOF'
use claim_secret_lib::derive_claim_secret;
fn _bind(erc20: EthAddress, sender: EthAddress, publish: bool) -> AztecAddress {
    let l1_factory = self.storage.l1_factory.read();
    let secret = if publish { REGISTER_SECRET } else { BIND_HARNESS_SECRET };
    self.context.consume_l1_to_l2_message(content, [secret], sender, register_leaf_index);
}
fn claim_public(to: AztecAddress, amount: u128, secret: Field, message_leaf_index: Field) {
    self.context.consume_l1_to_l2_message(content_hash, [secret], portal, message_leaf_index);
}
fn claim_private(recipient: AztecAddress, amount: u128, claim_salt: Field, message_leaf_index: Field) {
    let secret = derive_claim_secret(claim_salt, recipient);
    self.context.consume_l1_to_l2_message(content_hash, [secret], portal, message_leaf_index);
}
EOF
	check_file "$tmp/hub_sender.nr" 3 >/dev/null 2>&1 && { echo "SELF-TEST FAIL: hub caller-sender register regression accepted" >&2; fails=1; }

	# Regression 9: two consume sites on ONE line (a line count would see one).
	cat >"$tmp/one_line.nr" <<'EOF'
use claim_secret_lib::derive_claim_secret;
fn claim_public(to: AztecAddress, amount: u128, secret: Field, message_leaf_index: Field) {
    self.context.consume_l1_to_l2_message(content_hash, [secret], portal, message_leaf_index); self.context.consume_l1_to_l2_message(other, [secret], portal, other_leaf);
}
fn claim_private(recipient: AztecAddress, amount: u128, claim_salt: Field, message_leaf_index: Field) {
    let secret = derive_claim_secret(claim_salt, recipient);
    self.context.consume_l1_to_l2_message(content_hash, [secret], portal, message_leaf_index);
}
EOF
	check_file "$tmp/one_line.nr" >/dev/null 2>&1 && { echo "SELF-TEST FAIL: two-consumes-on-one-line regression accepted" >&2; fails=1; }

	# Regression 10 (hub shape): a PARAMETER named l1_factory instead of the storage read.
	cat >"$tmp/hub_param_factory.nr" <<'EOF'
use claim_secret_lib::derive_claim_secret;
fn _bind(erc20: EthAddress, l1_factory: EthAddress, publish: bool) -> AztecAddress {
    let secret = if publish { REGISTER_SECRET } else { BIND_HARNESS_SECRET };
    self.context.consume_l1_to_l2_message(content, [secret], l1_factory, register_leaf_index);
}
fn claim_public(to: AztecAddress, amount: u128, secret: Field, message_leaf_index: Field) {
    self.context.consume_l1_to_l2_message(content_hash, [secret], portal, message_leaf_index);
}
fn claim_private(recipient: AztecAddress, amount: u128, claim_salt: Field, message_leaf_index: Field) {
    let secret = derive_claim_secret(claim_salt, recipient);
    self.context.consume_l1_to_l2_message(content_hash, [secret], portal, message_leaf_index);
}
EOF
	check_file "$tmp/hub_param_factory.nr" 3 >/dev/null 2>&1 && { echo "SELF-TEST FAIL: hub parameter-named-l1_factory regression accepted" >&2; fails=1; }

	# Regression 11: the expected shapes survive only inside comments; the live code is a bearer path.
	cat >"$tmp/commented.nr" <<'EOF'
use claim_secret_lib::derive_claim_secret;
fn claim_public(to: AztecAddress, amount: u128, secret: Field, message_leaf_index: Field) {
    self.context.consume_l1_to_l2_message(content_hash, [secret], portal, message_leaf_index);
}
fn claim_private(recipient: AztecAddress, amount: u128, claim_salt: Field, message_leaf_index: Field) {
    // let secret = derive_claim_secret(claim_salt, recipient);
    // self.context.consume_l1_to_l2_message(content_hash, [secret], portal, message_leaf_index);
    self.context.consume_l1_to_l2_message(content_hash, [claim_salt], portal, message_leaf_index);
}
EOF
	check_file "$tmp/commented.nr" >/dev/null 2>&1 && { echo "SELF-TEST FAIL: commented-out-shapes regression accepted" >&2; fails=1; }

	# Regression 12 (hub shape): the storage read is BLOCK-commented; the live sender is a parameter.
	cat >"$tmp/hub_block_comment.nr" <<'EOF'
use claim_secret_lib::derive_claim_secret;
fn _bind(erc20: EthAddress, l1_factory: EthAddress, publish: bool) -> AztecAddress {
    /* let l1_factory = self.storage.l1_factory.read(); */
    let secret = if publish { REGISTER_SECRET } else { BIND_HARNESS_SECRET };
    self.context.consume_l1_to_l2_message(content, [secret], l1_factory, register_leaf_index);
}
fn claim_public(to: AztecAddress, amount: u128, secret: Field, message_leaf_index: Field) {
    self.context.consume_l1_to_l2_message(content_hash, [secret], portal, message_leaf_index);
}
fn claim_private(recipient: AztecAddress, amount: u128, claim_salt: Field, message_leaf_index: Field) {
    let secret = derive_claim_secret(claim_salt, recipient);
    self.context.consume_l1_to_l2_message(content_hash, [secret], portal, message_leaf_index);
}
EOF
	check_file "$tmp/hub_block_comment.nr" 3 >/dev/null 2>&1 && { echo "SELF-TEST FAIL: block-commented storage read regression accepted" >&2; fails=1; }

	# Regression 13: a `//` inside a string literal must not hide the live primitive after it.
	cat >"$tmp/string_slash.nr" <<'EOF'
use claim_secret_lib::derive_claim_secret;
fn claim_public(to: AztecAddress, amount: u128, secret: Field, message_leaf_index: Field) {
    self.context.consume_l1_to_l2_message(content_hash, [secret], portal, message_leaf_index);
}
fn claim_private(recipient: AztecAddress, amount: u128, claim_salt: Field, message_leaf_index: Field) {
    let secret = derive_claim_secret(claim_salt, recipient);
    let url = "https://x"; let m = self.context.process_l1_to_l2_message(claim_salt, message_leaf_index);
    self.context.consume_l1_to_l2_message(content_hash, [secret], portal, message_leaf_index);
}
EOF
	check_file "$tmp/string_slash.nr" >/dev/null 2>&1 && { echo "SELF-TEST FAIL: string-literal-slash regression accepted" >&2; fails=1; }

	# Regression 14: a block-comment opener and closer inside two strings bracket a live bearer path.
	cat >"$tmp/string_block.nr" <<'EOF'
use claim_secret_lib::derive_claim_secret;
fn claim_public(to: AztecAddress, amount: u128, secret: Field, message_leaf_index: Field) {
    self.context.consume_l1_to_l2_message(content_hash, [secret], portal, message_leaf_index);
}
fn claim_private(recipient: AztecAddress, amount: u128, claim_salt: Field, message_leaf_index: Field) {
    let secret = derive_claim_secret(claim_salt, recipient);
    let open = "/*";
    let m = self.context.process_l1_to_l2_message(claim_salt, message_leaf_index);
    let close = "*/";
    self.context.consume_l1_to_l2_message(content_hash, [secret], portal, message_leaf_index);
}
EOF
	check_file "$tmp/string_block.nr" >/dev/null 2>&1 && { echo "SELF-TEST FAIL: block-comment-in-strings regression accepted" >&2; fails=1; }

	# Regression 7 (hub shape): the register consume takes a caller secret instead of REGISTER_SECRET.
	cat >"$tmp/hub_secret_register.nr" <<'EOF'
use claim_secret_lib::derive_claim_secret;
fn _bind(erc20: EthAddress, secret: Field, publish: bool) -> AztecAddress {
    let l1_factory = self.storage.l1_factory.read();
    self.context.consume_l1_to_l2_message(content, [secret], l1_factory, register_leaf_index);
}
fn claim_public(to: AztecAddress, amount: u128, secret: Field, message_leaf_index: Field) {
    self.context.consume_l1_to_l2_message(content_hash, [secret], portal, message_leaf_index);
}
fn claim_private(recipient: AztecAddress, amount: u128, claim_salt: Field, message_leaf_index: Field) {
    let secret = derive_claim_secret(claim_salt, recipient);
    self.context.consume_l1_to_l2_message(content_hash, [secret], portal, message_leaf_index);
}
EOF
	check_file "$tmp/hub_secret_register.nr" 3 >/dev/null 2>&1 && { echo "SELF-TEST FAIL: hub caller-secret register regression accepted" >&2; fails=1; }

	if [ "$fails" -ne 0 ]; then echo "❌ check-sole-consumer self-test FAILED" >&2; exit 1; fi
	echo "✅ check-sole-consumer self-test passed (the hub source upheld; 14 bearer regressions rejected)"
	exit 0
fi

if [ "$#" -gt 0 ]; then
	check_file "$1" "${2:-2}" || exit 1
	echo "✅ sole-consumer invariant holds for $1"
	exit 0
fi
check_file "$here/token_bridge_hub/src/main.nr" 3 || exit 1
echo "✅ sole-consumer invariant holds: token_bridge_hub 3 sites (_bind, claim_public, claim_private); claim_private derives (no raw-secret path)"
