# Phase 2 — L2 recipient-commitment + cross-toolchain keystone

**Status: ✓ — the recipient-commitment core, proven byte-identical across Noir + TS.**

## Delivered

- `contracts/bridge/aztec/claim_secret/` — new Noir lib (the shared derivation both `token_bridge` and `keystone` depend on, so they can't drift). `derive_claim_secret(claim_salt, recipient) = poseidon2_hash_with_separator([claim_salt, recipient.to_field()], 3140354885)`. DS pinned literal `DOM_SEP__TOKEN_BRIDGE_PRIVATE_CLAIM_SECRET`.
- `contracts/bridge/aztec/token_bridge/src/main.nr` — `claim_private` rewritten: signature `(recipient, amount, claim_salt, message_leaf_index)` (raw-secret param REMOVED), derives the consumption secret in-circuit, `assert(!recipient.is_zero())` added, sole-consumer invariant documented at the entrypoint.
- Path-deps wired: `token_bridge/Nargo.toml` + `keystone/Nargo.toml` → `claim_secret`.
- `contracts/bridge/aztec/keystone/src/main.nr` — 3 new tests: DS pin (+ ≠ FPC), 3 derivation-secret vectors, 3 secretHash vectors.
- `contracts/bridge/aztec/scripts/check-sole-consumer.sh` — static A2 tripwire: exactly 2 `consume_l1_to_l2_message` sites, private path derives (no raw-secret arg).
- `packages/bridge-core/src/claim-secret.ts` + `claim-secret.test.ts` — TS mirror + keystone (DS re-derivation from string, DS ≠ FPC ≠ SECRET_HASH, 3 vectors).

## Validation gate — RESULT (all green)

- sole-consumer static check: ✅ (2 consume sites, derives, no raw-secret path).
- `bash contracts/bridge/aztec/scripts/compile.sh` (rc.2 toolchain): all 3 contracts compile + transpile + VK for the new `claim_private`.
- `keystone aztec-nargo test`: **6/6** (3 content-hash pins unchanged + 3 new claim-secret pins).
- `token_minter_proxy aztec-nargo test`: 0 tests, compiles (byte-stable artifact — no toolchain drift, per the gate).
- artifact-diff: **only `token_bridge` target changed** (+47/-33, the new circuit); `token_minter_proxy` artifact byte-identical. ✓
- `bun run --cwd packages/bridge-core test`: **133 passed** (+4 from claim-secret keystone).
- `bun run --cwd packages/bridge-core typecheck`: clean. `bun run lint`: clean.

## The load-bearing result: Noir ↔ TS byte-match

The DS `3140354885` + all 3 `(salt, recipient) → secret/secretHash` vectors are asserted with the SAME literals in BOTH `keystone/src/main.nr` (Noir) and `claim-secret.test.ts` (TS), and both pass. So `derive_claim_secret` (Noir, in-circuit) ≡ `deriveTokenClaimSecret` (TS, at deposit) — the recipient-commitment binding is real and any future `@aztec` poseidon/field-encoding drift trips the keystone before it can strand a deposit. `compute_secret_hash` (aztec-nr `hash.nr:16` = `poseidon2_hash_with_separator([secret], DOM_SEP__SECRET_HASH)`) matches TS `computeSecretHash`.

## Notes for later phases

- Consumption-WIRING correctness (that the derived secret actually consumes a real message end-to-end) is NOT proven by Phase 2 — the keystone proves the derivation round-trips, not the circuit's message consumption. First proof is the Phase 4 sandbox smoke (as planned / fresh-audit M3).
- `deriveTokenClaimSecret`/`tokenClaimSecretHash` are exported but not yet consumed — Phase 3 wires them into `flows.ts` (private deposit) + `runSwapBridge` (the fueled-private token leg's `tokenClaimSalt`).
- API note: rc.2 `AztecAddress` has `fromBigIntUnsafe`/`fromFieldUnsafe`, NOT `fromField` (the rc.2 `from*Unsafe` rename).
