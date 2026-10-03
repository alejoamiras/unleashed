# Phase 3 — bridge-core single-path + relayer script

**Status: ◑ CORE DONE (committed, green), remainder is Phase-5-coupled or live-only.**

## Done + verified

- `router-abi.ts` — added `bridge` fn + `Bridge` event; **pinned against the compiled forge artifact** (`router-abi.test.ts`, 4/4). My hand-written ABI matches the Solidity byte-for-byte.
- `flows.ts`:
  - `runRouterDeposit` — the single bridge-only/fuel-only Permit2 deposit path (sign witness with fuel fields zeroed → `bridge()` → leaf from the `Bridge` event). Private derives the secret from `(claimSalt, recipient)`; the persisted/returned value is the SALT.
  - `runSwapBridge` — added required `tokenClaimSalt` for the fueled-private token leg with a fail-closed guard (F2). The token leg now binds `deriveTokenClaimSecret(salt, recipient)` instead of `Fr.random()` — proven by a new assertion (`tokenSecretHash == tokenClaimSecretHash(salt, recipient)`) + a dedicated rejection test.
  - F-007 bearer warnings (RecoveryHooks + SwapRecoveryHooks) rewritten to the recipient-committed model (salt loss strands; salt leak = linkage privacy, not theft).
- `l2.ts` — `claim_private` salt semantics documented; `claimPrivate` passes the salt; `submitPrivateClaim` alias for relayer call sites.
- Gate results: `bun run --cwd packages/bridge-core test` **136 passed** (+3 across the phase); `typecheck` clean; `lint` clean.

## Deliberately deferred (with reasons — NOT skipped)

- **Direct-path DELETION** (`runDeposit`/`depositPublic`/`depositPrivate` + the no-direct-write grep-gate + the 5-site `claim_private` stale-semantics grep, C2/M1): moved to **Phase 5**. Deleting these now breaks the faucet's imports (`useDeposit.ts`) → `typecheck:all` red between phases. Per the always-green discipline they're kept present-but-superseded until Phase 5 rewires the faucet's last caller; then the deletion + both grep-gates run. Same end state (direct path gone by Phase 5), consistent with L9.
- **Relayer script** `scripts/relay-claim-testnet.ts` + **testnet-script rewires** (`deposit-testnet.ts`, `fuel-testnet.ts`, `smoke-existing-testnet.ts`): these are LIVE-ONLY (need an Aztec account + a running sandbox/testnet to exercise). Authoring them without the ability to run them adds unverified code; they're built + first-run in **Phase 4** (sandbox) and **Phase 7** (live canaries) where they can actually be proven. `submitPrivateClaim` (the l2 primitive the relayer uses) is already in place.

## Resume point

Phase 4 (sandbox smoke) is the next executable phase — it needs a running Aztec sandbox (`aztec start --sandbox` or the repo's parallel-safe runner), then `deploy-sandbox.ts --smoke` extended with the router path + the relayer leg. The relayer script gets authored there (first place it can run). Phase 5 then rewires the faucet and completes the direct-path deletion + grep-gates.
