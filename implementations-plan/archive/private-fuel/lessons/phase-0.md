# Phase 0 — safety keystone (determinism + secret parity + schema)

Status: **code green; Ask 1 (version gap) RESOLVED — testnet 4.3.1 backward-compatible with the 4.2.0 artifact (see foot).** Moves no funds.

## What shipped
- `packages/bridge-core/src/private-fuel.ts` — `deriveBridgeSecret`, `privateFuelSecretHash`, `DOM_SEP__FPC_BRIDGE_SECRET`, pinned `PRIVATE_FPC_ADDRESS`.
- `packages/bridge-core/src/private-fuel.test.ts` — keystone (DOM_SEP + 3 secret/secretHash vectors) + the address tripwire (re-derive from the installed artifact). 5/5 green.
- `packages/bridge-core/src/journal.ts` — `DepositFuelBlock` gains optional `bridgeSecretSalt?`/`fpc?`; schema-semantics comment made coherent (record vs envelope version).
- `packages/bridge-core/scripts/check-fpc-version.ts` — read-only pre-P4 fail-closed version gate.
- `packages/bridge-core/package.json` — `@wonderland/aztec-fee-payment` (`prerelease-215fd08` tarball) added.

## Pinned values (from the installed `4.2.0-prerelease.215fd08` artifact, `salt=0, deployer=ZERO`)
- `DOM_SEP__FPC_BRIDGE_SECRET = 3952304070` — plan's claim **verified TRUE** (not trusted blindly).
- `PRIVATE_FPC_ADDRESS = 0x1b1706cc0947eca1de6527562af65d43e95540f9009a896dcd847afea92ede1e`
- `classId = 0x2ffdb21996186d695cb4cd93175b83a9ded8c7975a94f32bef7859b1ec50e302`
- artifact `noir_version = 1.0.0-beta.19+842974fcf034b0a652631e69fc24f92f9ddd1d37`

The address matches the wallet's registered instance **by construction**: identical artifact (same tarball), identical params, identical `@aztec` 4.2.0 — so the class-id and address are deterministic and equal. The tripwire test guards any future drift.

## Design decision: pinned constant + CI tripwire, NOT runtime re-derivation (L2/L15)
bridge-core is bundled into the faucet's **browser** build. The raw 2.2 MB artifact is outside the package's `exports` map, and Wonderland's `./artifacts/private` JS wrapper imports `@aztec/aztec.js/*` (`document`/`window` — breaks the browser bundle). So:
- **Runtime path** = the 66-char `PRIVATE_FPC_ADDRESS` constant only. No artifact, no `aztec.js`, no 2.2 MB in the bundle.
- **Test path** = re-derive from the installed artifact (node-only, walks `node_modules` past the exports map) and assert equality.

This is **strictly stronger** than literal runtime re-derivation for fail-closed safety: the runtime can never read the mutable artifact, so it can never silently deposit to a drifted address. A Wonderland bump that changes the bytecode fails the tripwire in CI, forcing a conscious re-pin + re-canary. (If a reviewer insists on a runtime re-derive, it would only re-add bundle weight + the document/window risk for no added safety.)

## Schema refinement over plan L8
Plan L8 listed `bridgeSecretSalt?`/`fpc?`/`fuelPrivacy?`. **Dropped `fuelPrivacy`** — gas-follows-token (L10) makes `record.isPrivate` the single source of truth for fuel privacy; a separate field would be denormalized and could disagree. Added only `bridgeSecretSalt?` + `fpc?`. The codex "root-schema bug" (L8 condition) addressed by clarifying that the per-record `schema` (1|2) is distinct from the storage envelope version (always 1), is redundant with `!!fuel` for deposits, and that private-fuel fields are additive WITHIN schema 2 (no bump).

## Version finding (Ask 1) — as-discovered (RESOLVED at foot)
`check-fpc-version.ts` against `https://rpc.testnet.aztec-labs.com`:
- **network `nodeVersion = 4.3.1`** (l1ChainId 11155111, rollupVersion 4127419662)
- **our pin = 4.2.0** (whole stack + the Wonderland artifact)

The pinned FPC address is derived from the 4.2.0 artifact. Whether the 4.3.1 network recognizes it is **unconfirmed**.

Analysis (moderate confidence):
- The existing PUBLIC bridge works with a 4.2.0 client against this same 4.3.1 testnet — strong evidence the core protocol hashing (content hashes, L1→L2 message keys, class-id/address derivation) is **compatible** across the 4.2→4.3 minor bump. If address derivation is stable, `0x1b1706cc…` is the right address on 4.3.1 too.
- The residual risk is narrower: does 4.3.1 **accept a private call** (`mint_and_pay_fee`) on a PrivateFPC class compiled with noir-beta.19/4.2.0? Only the **dust canary (P4)** proves this.
- So the mismatch does NOT necessarily change the plan — the plan's dust-canary-first design is exactly the mitigation. But it is a genuine **STOP before any fund-moving step**, and a user decision on how to resolve (canary-trust vs source a 4.3.x Wonderland artifact + re-pin vs bump the stack).

## Browser-safety note (deferred validation)
`poseidon2*` from `@aztec/foundation/crypto/sync` is not yet used in browser-bundled bridge-core/faucet code. P0 validates it in node (vitest). Real browser-bundle validation lands at P3 (`audit:vue` / faucet build). The feature inherently needs poseidon2 in-browser (to build the deposit secret), so this is on the critical path; the wallet uses the same primitives in the browser, which de-risks it.

## Gate result
- `bun run --cwd packages/bridge-core typecheck` → exit 0.
- `bun run --cwd packages/bridge-core test` → 16 files, **104/104** green (private-fuel 5/5 + no journal regressions).
- `check-fpc-version.ts` → records versions; MAJOR-only fail-closed guard (minor 4.2↔4.3 is backward-compatible).

## Ask 1 RESOLVED (user)
The version gap is NOT a blocker. The user confirmed the live testnet (4.3.1) is backward-compatible
with — and has DEPLOYED — everything 4.2.0 has, including the PrivateFPC class. So the 4.2.0-derived
`PRIVATE_FPC_ADDRESS` is the address the network recognizes; no re-pin, no stack bump. This matches the
independent evidence (the public-fuel bridge already runs a 4.2.0 client against this 4.3.1 testnet).
`check-fpc-version.ts` softened from a major.minor-equality hard-fail to a MAJOR-only guard (minor diffs
are backward-compatible); the P4 dust canary remains the cheap belt-and-suspenders on-network proof.
P1–P5 proceed on the 4.2.0 pin.
