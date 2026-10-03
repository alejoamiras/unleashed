# Phase 1 — re-pin V5 portal + helper guard + fork-validate

## What shipped
- Re-pinned `FEE_JUICE_PORTAL` `0xd3361019…` (V4) → `0x7C4176bFF969c9417e42F9CB921100145911CC84` (V5, EIP-55 checksummed) in 5 sites: `DeployFuelLive.s.sol:45`, `DeployBridge.s.sol:131`, `DeployFuelLive.fork.t.sol:34`, `DeployBridge.fork.t.sol:22`, `.env.example:20`. Confirmed zero `0xd3361019` left in bridge-evm src/script/test/env.
- Guarded `PoolSetupHelper` (`DeployFuelLive.s.sol:93`): read `SEED_AZLO_WETH`/`SEED_ETH_FJ` up front, only `new PoolSetupHelper(...)` if either is true, and the two seed blocks now key off the locals. Makes a reuse-the-swap re-run (FUEL_SWAP_ADDRESS set, both SEED_* false) genuinely router-only — closes the codex BLOCKER that Phase 2's pass criterion was impossible.

## Validation results
- `forge build` (guarded script + both fork tests): **Compiler run successful** (pre-existing unused-import note on `PoolId` only).
- Non-fork forge suite: **34/34 green** (`forge test --no-match-path 'test/*.fork.t.sol'`).
- `DeployFuelLive.fork.t.sol`: 1 pass / 3 fail.

## The fork-test failures are pre-existing live-state drift, NOT the portal change (proven)
The 3 failures (`test_productionTopology_publicAndPrivate_realPortals`, `test_repeatPurchasesClearTheFloor`, `test_frontRunGuardTripsOnGarbagePrice`) all revert with `PoolAlreadyInitialized()` (`0x7983c051`) at `PoolManager.initialize(...)` during the test's pool-SEEDING setup — **before any `depositToAztecPublic` on the fee-juice portal**. The portal address only affects the later swap+bridge step, so it cannot cause an init-stage revert.

**Rigorous proof**: `git stash push -- packages/bridge-evm/` (revert ALL my edits) → re-run → the SAME 3 tests fail with the SAME `PoolAlreadyInitialized`. The failures are identical on the unmodified V4 code → independent of the portal re-pin.

**Cause**: the test uses `LIVE_AZLO=0xA40A2FE1` (the original holonym AZLO) and `vm.createSelectFork(rpc)` at LATEST Sepolia. Its AZLO/WETH + ETH/FJ pools are already initialized on live Sepolia (seeded for real previously), so the test's fresh `initialize` reverts. The test was written assuming clean (uninitialized) pools — an assumption that stopped holding once the pools were seeded live. The `_guardPrice`-based reuse path exists for the production `setup`, but `test_frontRunGuardTripsOnGarbagePrice` expects a fresh init, and the topology test's helper.setup calls `initialize` directly.

**Why my change didn't make it worse**: the fork test never reaches the portal, so the V5-vs-V4 portal address is untested by it either way. The portal-acceptance evidence comes from: (a) live `cast` — V5 portal `0x7c4176bf` has code + `UNDERLYING()==0x762c` (the FJ the swap outputs); (b) ABI match — `FeeJuicePortal.depositToAztecPublic(bytes32,uint256,bytes32)→(bytes32,uint256)` == the router's `IFeeJuicePortal`; (c) the authoritative proof is Phase 3's REAL self-paying claim (codex round-1: "the e2e self-paying claim remains the real proof").

## Decision (codex-consulted, session `019ee5b2`)
Verdict: **proceed with changes.** Codex sharpened the framing: the `git stash` equivalence proves *attribution* (not my change) but NOT *acceptance* (that the V5 path works). Crucially, this fork test isn't uniquely valuable — it dies in pool-seeding setup *before* `depositToAztecPublic`, so treating it as a blocker is "fake rigor"; and even green it would only prove `router.feeJuicePortal()==…` + FJ balance moved, not message/claim semantics. **Phase 3's real self-paying claim is strictly stronger.** Adopted:
1. Reframed the Phase 1 gate as **compile + non-regression evidence** (forge build + 34/34 non-fork + stash-equivalence), NOT a portal-acceptance gate. Portal acceptance explicitly moved to Phase 3.
2. Strict candidate-first in Phase 2/3: redeploy router → update CANDIDATE only → real smoke → promote live ONLY after it's green. Risk is testnet gas/time, not a user-facing cutover.
3. **Skipped** codex's optional salvage (make the fork test idempotent vs already-init pools): it requires changing the shared `PoolSetupHelper` used by the live deploy — not "obviously small" on security-reviewed bridge infra, and codex said skip-if-not-small. Did NOT pin an old fork block (codex: "restores greenness by dodging reality").

`LESSONS_FILE=implementations-plan/archive/fuel-portal-v5-fix/lessons/phase-1.md`

## Follow-up (out of scope here)
`DeployFuelLive.fork.t.sol` (+ `DeployBridge.fork.t.sol`) pool-seeding assumes uninitialized pools, broken by live seeding. Fix later: make the helper/test idempotent — if `slot0 != 0` and price within tolerance, skip init/reseed and use existing live liquidity; fail only on garbage-price init. NOT a fork-block pin.

## Phase 1: ✓ (gate = compile + 34/34 non-fork green + stash non-regression; portal acceptance → Phase 3)
