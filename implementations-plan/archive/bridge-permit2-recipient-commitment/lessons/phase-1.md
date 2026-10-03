# Phase 1 — L1 fuzz suite + bridge() fork legs

**Status: ✓ (phase deliverables all green; one pre-existing out-of-scope live-drift failure noted below)**

## Delivered

- `contracts/bridge/evm/test/SwapBridgeRouterFuzz.t.sol` — the 5 fuzz targets (mock-based):
  1. `testFuzz_witnessTamperChangesHash` — every 1 of 12 witness fields binds.
  2. `testFuzz_bridgeAccounting` — `bridge()` over [1, 2^128): portal gets exactly `amount`, zero residue.
  3. `testFuzz_fuelSplit` — valid fuel split conserves + zero residue.
  4. `testFuzz_hostileSwapConsumption` — full behavior lattice of the owner-replaceable swap.
  5. `testFuzz_hostilePortal` — the arbitrary-`tokenPortal` trust boundary (honest → 0 residue; non-pulling → strands, sweepable).
- `contracts/bridge/evm/test/SwapBridgeRouterPermit2Fork.t.sol` — +7 fork legs: 5 `bridge()` legs (public/private/replay/expiry/tamper) against real Permit2, `test_fuelOnly_realFeeJuicePortal` (I2), `test_deployedRouter_hasBridgeSelector` (I1 positive probe).

## Validation gate — RESULT

- `forge build && forge test` (no RPC): **34 passed, 0 failed, 3 skipped** (fork suites skip without `SEPOLIA_RPC_URL`). Fuzz visibly runs 256 each.
- `SEPOLIA_RPC_URL=<public> forge test --match-contract SwapBridgeRouterPermit2ForkTest`: **12/12 PASSED** (named legs, not skipped — satisfies fresh-audit HIGH-3). Ran against the public `ethereum-sepolia-rpc.publicnode.com` (from `.env.example`, not a secret).

## Two inferences upgraded to VERIFIED FACTS

- **I1 proven**: `test_deployedRouter_hasBridgeSelector` — the deployed router `0x4c3f…4068` reverts with the exact `"SwapBridgeRouter: zero amount"` guard string on a zero-amount `bridge()` call → the selector is present in the live bytecode AND reaches the body. The whole "no router redeploy" architecture (ledger L1/L2) rides on real bytecode now.
- **I2 proven**: `test_fuelOnly_realFeeJuicePortal` — `bridge(tokenPortal = canonical FeeJuicePortal 0xb06a…)` pulls the real fee asset via real Permit2 and deposits it to the real portal, zero residue. The zero-Solidity fuel-only bet holds against live chain state (and models the one-time `approve(Permit2)` the fee asset needs).

## Fuzz caught a real test-invariant bug (the fuzzer earning its place)

`testFuzz_hostileSwapConsumption` initially asserted `fj residue == 0` on success. Counterexample: a swap that OVER-transfers FJ (transfers more than it returns) leaves `transferred - returned` FJ in the router — the router deposits exactly `fuelReceived` (what the swap returned), so the excess is the swap's own donation, sweepable by owner, never user funds. Fixed the invariant to `fj residue == transferred - returned` + `feePortal.lastAmount() == returned`. Router behavior is correct; my assertion was wrong.

## Pre-existing, out-of-scope failure (NOT a Phase 1 regression)

Running the FULL suite with the RPC, 3 tests in `DeployFuelLive.fork.t.sol` fail — `test_frontRunGuardTripsOnGarbagePrice` (`PoolAlreadyInitialized()` 0x7983c051), `test_productionTopology_publicAndPrivate_realPortals`, `test_repeatPurchasesClearTheFloor`. Root cause: these rehearse deploying the LIVE production V4 pools, which are ALREADY initialized on today's Sepolia → re-init reverts. **`DeployFuelLive.fork.t.sol` is UNTOUCHED by this phase** (`git diff --stat` empty), a separate test contract with its own setUp — so this is live-state drift, not my change. It is **moot under the WIPE decision**: the live topology gets redeployed, and these rehearsals get re-pinned against the fresh state at that time. NOT silenced/weakened (gate-integrity rule) — recorded here and deferred to the redeploy phase.

## Toolchain note

`forge install` (foundry 1.7) force-added the libs as git submodules + a root `.gitmodules`, bypassing the evm `.gitignore` `lib/` rule. Unstaged them + removed `.gitmodules` + nested `.git` dirs so `lib/` stays untracked (matching the repo's "lib/ is gitignored, install fresh" model). Added `foundry.lock` to the evm `.gitignore`. Libs remain on disk; build + fuzz re-verified green after cleanup.
