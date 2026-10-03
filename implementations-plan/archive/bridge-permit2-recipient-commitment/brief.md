# Brief — bridge-permit2-recipient-commitment

Shared grounding for the three independent planners (main / codex / fable) under the `/blueprint deep` protocol. Everything here is verified against the repo unless marked otherwise.

## Task statement

Three coupled changes to the L1↔L2 bridge stack:

1. **(a) Permit2 for bridge-only ERC20.** Today only bridge+fuel uses Permit2; the bridge-only flow does `approve` + direct `TokenPortal.depositToAztec{Private,Public}`. Rewire bridge-only onto the router's Permit2 path and **delete the direct-portal path entirely** (user decision — single code path; this overturns the swap-fuel plan's "Decision L6" dual-path rationale).
2. **(b) Permit2 for fuel-only.** The Fuel tab does `approve` + `FeeJuicePortal.depositToAztecPublic` directly. Add a witness-bound Permit2 periphery for it (the FeeJuicePortal is canonical and cannot change).
3. **(c) Recipient-commitment for private claims.** The private deposit's content hash is `sha256ToField("mint_to_private(uint256)", amount)` — no recipient — so the claim secret is a bearer credential (red-team F-007, accepted-risk, "recipient-commitment is the documented end-state"). Bind the recipient so a relayer can submit the L2 claim *for* a user without being able to redirect funds.

Quality requirements: Foundry tests including **fuzzing** (suite currently has ZERO fuzz tests), succinct not verbose, per the repo's testing philosophy (smallest set that proves it works + expected failures caught).

## Phase 0 decisions (user-locked — do not re-litigate; attack consequences, not the choices)

- **(a):** rewire onto `SwapBridgeRouter.bridge()`; DELETE the direct approve+portal path (no config-flag fallback).
- **(c) design bias:** claimer-bound **secret derivation** (private-fuel precedent) over content-hash commitment. Planners may argue against IF they find a concrete hole in it; the bias stands otherwise.
- **Migration:** full testnet cutover IS in scope: deploy scripts, redeploy, faucet config update, live canaries. Old stack stays live for in-flight claims.
- **Relayer:** contract-level capability + tests where a DIFFERENT account submits `claim_private`, PLUS a minimal bridge-core relayer script (takes salt/recipient/amount/leaf, submits from a separate account; doubles as the live canary).
- **Validation layers:** local Foundry unit+fuzz on every contract phase; Sepolia fork tests pre-deploy; live testnet canaries post-deploy. **NO new contracts CI workflow in this plan** (user chose to defer to a follow-up plan; red-team F-003 remains open — record, don't fix here).
- **Hardening:** final phase = focused redteam-style re-audit of ONLY the new/changed surface (same shape as `audit/security/bridge-redteam/`, narrower).

## Verified ground truth

### L1 (Foundry project `contracts/bridge/evm/`, solc 0.8.28, via_ir)

- `src/SwapBridgeRouter.sol` — Permit2 periphery, `Ownable2Step` + `ReentrancyGuard`.
  - `bridgeWithFuel(BridgeParams, PermitParams)` (`:153`) — Permit2 witness pull → swap slice → FJ deposit → token deposit (public/private). LIVE, used by the faucet's fuel toggle.
  - **`bridge(SimpleBridgeParams, PermitParams)` (`:244`) — Permit2 witness-bound bridge-only entrypoint. Fully implemented + unit-tested, but DORMANT: the frontend bypasses it and `packages/bridge-core/src/router-abi.ts` doesn't expose it.**
  - Permit2 flavor: **SignatureTransfer `permitWitnessTransferFrom`** only (`:314-325`), never AllowanceTransfer. 12-field `BridgeWitness` (`:52-56`, `:113-126`) binds tokenPortal, bridgeToken, totalAmount, fuelAmount, aztecRecipient, fuelRecipient, tokenSecretHash, fuelSecretHash, minFuelOutput, routeHash, isPrivate, swapTarget.
  - `sweep(token,to)` onlyOwner (`:290`). forceApprove-to-zero discipline on every outbound leg.
- `src/UniswapFuelSwap.sol` — V4 swap engine, called only by the router via `forceApprove` + `safeTransferFrom` (`:103`). Not user-facing.
- `src/MintableERC20.sol` — testnet AZLO. `allowance()` override returns max for canonical Permit2 (`:47-50`) → Permit2 flows need NO approve tx **for this token only**. The canonical fee asset does NOT have this override.
- `src/interfaces/ITokenPortal.sol` — `depositToAztecPublic(bytes32 to, uint256 amount, bytes32 secretHash)`, `depositToAztecPrivate(uint256 amount, bytes32 secretHash)` (no recipient, by design).
- The forked portal — the DEPLOYED portal: minimal security fork of canonical TokenPortal adding only the F-001 init-once guard. Content hashes byte-identical to canonical: public = `sha256ToField("mint_to_public(bytes32,uint256)", to, amount)`; private = `sha256ToField("mint_to_private(uint256)", amount)`. `secretHash` goes into `inbox.sendL2Message(actor, contentHash, secretHash)` separately — NOT part of content. Compiled/deployed from the l1-contracts root via `scripts/build-portal-artifact.ts` (transitive @aztec imports don't resolve in the bridge-evm Foundry project), with a reviewed-bytes artifact.
- Tests (32 tests, 10 files, **zero fuzz**): `SwapBridgeRouter.t.sol` (mocks incl. MaliciousPrefundSwap), `RouteValidation.t.sol`, `MintableERC20.t.sol`, `WitnessHash.t.sol` (pins ROUTE_HASH/WITNESS_HASH ↔ `bridge-core/l1.test.ts`), `ContentHash.t.sol` (pins the 3 content-hash vectors ↔ Noir keystone ↔ TS `content-hash.ts`), `PortalReinit.t.sol` (F-001 regression via a shim of the forked portal), fork tests gated on `SEPOLIA_RPC_URL` (`SwapBridgeRouterPermit2Fork.t.sol` — real Permit2 + real V4; `DeployFuelLive.fork.t.sol` — live topology rehearsal; `DeployBridge.fork.t.sol`).
- **No CI runs forge anywhere.** Invocation is manual `forge test` per `contracts/bridge/evm/README.md`.
- Deploy scripts: `script/DeployBridge.s.sol` (fork-fixture), `script/DeployFuelLive.s.sol` (live, idempotent via env addresses, seeds AZLO/WETH + ETH/FJ pools, pool-init front-run guard). Live deploy needs `PRIVATE_KEY`, `SEPOLIA_RPC_URL`, optional `ETHERSCAN_API_KEY`.

### L2 (Noir, `contracts/bridge/aztec/`)

- `token_bridge/src/main.nr`:
  - `claim_public(to, amount, secret, leaf_index)` (`:92`) — content hash BINDS `to` → already recipient-committed; front-run = altruism.
  - `claim_private(recipient, amount, secret_for_L1_to_L2_message_consumption, leaf_index)` (`:104`) — content hash = `get_mint_to_private_content_hash(amount)` (amount only); `recipient` is a FREE argument steering `mint_to_private`. **This is the bearer property to remove.**
  - Content-hash lib: `token_portal_content_hash_lib` (check `token_bridge/Nargo.toml` for how it resolves — upstream lib, treat as unforkable without consequences).
  - Pause: private path via enqueued `_assert_not_paused` self-call.
- `token_minter_proxy/src/main.nr` — sole authorized minter; `owner`/`token`/`bridge` all `PublicImmutable`; `set_bridge` is ONE-TIME (`:39-44`, F-002 fix). **Consequence: a new bridge contract cannot be wired to the existing proxy/token → (c) forces redeploy of token + proxy + bridge + a fresh instance of the forked portal (portal's l2Bridge pointer is also init-once).**
- `keystone/src/main.nr` — Noir keystone pinning content-hash vectors against `ContentHash.t.sol` and TS `content-hash.ts` (three-toolchain drift guard; a drift strands deposits).

### TS (`packages/bridge-core/`)

- `flows.ts`: `runDeposit` (`:60-135`, bridge-only: mint→approve→deposit→claim; secret = `Fr.random()` at `:69`; leaf index from Inbox `MessageSent` event; L2 claim via `bridge.methods.claim_*().send()` in a bounded retry loop). `runSwapBridge` (`:271-373`, Permit2: builds witness → `bridgeWitnessPermitTypedData` → `wallet.signTypedData` → `bridgeWithFuel`; F-005 fail-closed private-fuel guards at `:282-293`). `RecoveryHooks`/`SwapRecoveryHooks` persist secrets BEFORE the irreversible L1 tx (F-007 bearer warning at `:42-53`).
- `l1.ts`: `BRIDGE_WITNESS_TYPE`, `BRIDGE_WITNESS_PERMIT_TYPES`, `bridgeWitnessPermitTypedData`, `hashRoute`/`hashBridgeWitness` (byte-pinned to `WitnessHash.t.sol` via `l1.test.ts`).
- `private-fuel.ts`: **the precedent for (c)** — `deriveBridgeSecret(salt, claimer) = poseidon2([salt, claimer], DOM_SEP__FPC_BRIDGE_SECRET=3952304070)` (`:52-53`); `PRIVATE_FPC_ADDRESS` pinned; the private FUEL secret is claimer-bound already (swap-fuel Decision L3). A NEW domain separator is required for the token-bridge derivation (cross-protocol secret reuse hazard).
- `content-hash.ts`: TS keystone leg — `mintToPrivateContentHash(amount)` (no recipient), `mintToPublicContentHash(to, amount)`.
- `router-abi.ts`: exposes ONLY `bridgeWithFuel` today.
- `fuel.ts`: fuel-only plans — `depositToAztecPublic` on FeeJuicePortal always; private fuel lands at `PRIVATE_FPC_ADDRESS` with derived secret.
- Tests: vitest (`bun run --cwd packages/bridge-core test`), incl. pins `l1.test.ts`, F-005 rejection tests in `flows.test.ts`.

### Faucet (`apps/faucet/`)

- Three tabs: Faucet / Bridge / Fuel. Bridge tab has privacy toggle + "ARRIVE WITH GAS" fuel toggle.
- `useDeposit.ts` `deposit()` branches: fuel ON → Permit2 sign + `bridgeWithFuel` (`:714-847`, fail-closed Permit2-allowance assert `:718-726`); fuel OFF → approve (allowance-skipped) + direct portal deposit (`:849-926`); private secret = `Fr.random()` (`:637`), sealed at rest.
- `useFuel.ts` fuel-only: approve + `FeeJuicePortal.depositToAztecPublic` (`:151-169`).
- `bridge-steps.ts` stepper phases: fueled → SIGN; non-fueled + fuel-only → APPROVE. Deleting the direct path collapses these to SIGN everywhere (plus a possible one-time APPROVE step for the fee asset, see below).
- Deployed config: `public/testnet-bridge.json` (portal `0x96de…f864` = the forked-v1 portal; router `0x4c3f…4068`; swapTarget `0xab3a…0eb8`; AZLO `0x457f…d389`; feeJuicePortal `0xb06a…0a3a`; fee asset `0x762c…3c18`; canonical Permit2). `src/contracts/bridge-deployments.ts` reads it; `verify:deployments` gates the faucet build (`audit:faucet`).
- The wallet does NOT touch the token bridge; claims are faucet-side through the user's connected wallet.

### Red-team context (`audit/security/bridge-redteam/`)

F-001 portal reinit (fixed via fork, always-on regression test). F-002 minter-proxy (single-minter half fixed; immutable-owner half remains). F-003 contract tests + keystone not in CI (OPEN; deferred to follow-up plan by user decision). F-004 swapTarget witness-bound (fixed). F-005 fail-closed private-fuel invariants (fixed). F-007 bearer private claim (THIS PLAN's item c). INFO-1: MintableERC20's Permit2 pre-approval is a testnet-only luxury — "severe production footgun if copied to a value token".

## Design considerations the plans MUST address

1. **(c) secret-derivation mechanics**: `claim_private(recipient, amount, salt, leaf_index)` re-derives `secret = poseidon2([salt, recipient], NEW_DOM_SEP)` in-circuit and consumes with it. L1 deposit computes `secretHash = computeSecretHash(poseidon2([salt, recipient]))` client-side — portal bytecode + content hashes + all keystone pins UNCHANGED. Attack it: is the binding sound? Does `computeSecretHash`'s own hashing interact? Domain-separation from the FPC's 3952304070? Does the OLD bearer path have to be fully removed for the property to hold (yes — verify no alternate entrypoint survives)? What does the relayer learn (recipient — inherent) and what can it grief?
2. **(b) fuel periphery shape**: extend `SwapBridgeRouter` with a `fuel()` entrypoint (router redeploy — cheap, stateless, and a redeploy is happening anyway) vs a separate minimal periphery contract. New witness type or reuse? The FJ content hash already binds `(to, amount)` so fuel is recipient-committed; the witness's job is intent-integrity (portal, recipient, amount, secretHash, deadline).
3. **Fee-asset approve UX**: canonical fee asset lacks the Permit2 pre-approval → fuel-only Permit2 needs a one-time `approve(Permit2, max)` step (standard mainnet pattern). Stepper/UI copy handles "first time: approve once + sign" vs "after: sign only". Fail-closed allowance assert like `useDeposit.ts:718-726`.
4. **Direct-path deletion blast radius**: `flows.ts` runDeposit/depositPublic/depositPrivate, `useDeposit.ts` non-fuel branch, `bridge-steps.ts` approve phases, leaf-index extraction moves from Inbox `MessageSent` to the router's `Bridge` event, sandbox deploy scripts, any e2e consumers — enumerate and verify.
5. **Migration/cutover**: new token+proxy+bridge (+fresh portal instance, same bytecode) deploy; `testnet-bridge.json` + `verify:deployments`; old stack stays live for in-flight claims; sealed deposit records in faucet localStorage — do they pin the old addresses (verify how records store contract identity)? Canary set: public bridge, private bridge, private bridge claimed BY RELAYER (separate account), bridge+fuel, fuel-only Permit2.
6. **Fuzz strategy** (succinct, not verbose): witness hashing round-trips, bridge/fuel param bounds, amount edge cases (0, max, fuelAmount≥totalAmount), malicious swap target invariants, secret-derivation vectors pinned across Noir/TS (new keystone-style pin for the derivation!), nonce/deadline/tamper on the new entrypoint (fork test).
7. **Witness/type-string drift**: any new or changed witness must update TYPEHASH + TYPE_STRING + `_hashBridgeWitness` + TS mirror + pinned vectors in the same phase.
8. **Do NOT bump the @aztec/* line** (5.0.0-rc.2) in this plan; that has its own runbook.

## Real validation commands (per-phase gates draw from these ONLY)

- Foundry: `cd contracts/bridge/evm && forge build && forge test` (fork legs auto-skip without `SEPOLIA_RPC_URL`; with it, fork suites run).
- Noir: `cd contracts/bridge/aztec/<pkg> && nargo test` (TXE tests; check existing invocation docs in each package).
- bridge-core: `bun run --cwd packages/bridge-core test` and `bun run --cwd packages/bridge-core typecheck`.
- Faucet: `bun run test:faucet`, full gate `bun run audit:faucet` (typecheck:all → test:faucet → lint → verify:deployments → build:faucet).
- Repo-wide: `bun run lint`, `bun run typecheck:all`.
- Live canaries: bridge-core scripts pattern (`scripts/deposit-testnet.ts`, `scripts/fuel-testnet.ts`, `scripts/smoke-swap-existing-testnet.ts`) — extend/add, run manually with funded env.

## Required plan structure

Phases with per-phase validation gates (commands + pass criteria + layers), a Security & Adversarial Considerations section (threat model incl. reorg/replay/front-running/witness tampering/signature reuse), an Assumptions section split Facts / Inferences / Asks, rollout/cutover sequencing, rollback thinking, and the focused re-audit as the final phase. Repo-relative paths only. Testing philosophy: smallest sufficient set, fuzz where it earns its keep, at least one real-data integration test for external-system data.
