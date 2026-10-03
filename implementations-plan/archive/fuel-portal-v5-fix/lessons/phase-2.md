# Phase 2 — redeploy the SwapBridgeRouter against the V5 portal (router-only)

## What shipped
Redeployed ONLY the `SwapBridgeRouter` wired to the V5 fee-juice portal, reusing the existing `UniswapFuelSwap` + already-seeded pools.

- Env: `TOKEN_ADDRESS=0xad6890e9…` (V5 AZLO, for the `token < WETH` require), `FUEL_SWAP_ADDRESS=0x459ea79d…` (reuse swap), `SEED_AZLO_WETH=false`, `SEED_ETH_FJ=false`.
- Command: `forge script script/DeployFuelLive.s.sol --tc DeployFuelLive --rpc-url <rpc> --broadcast --slow`.

## Validation results (gate PASSED)
- **Dry-run plan: exactly 1 transaction** — `CREATE SwapBridgeRouter` (no `UniswapFuelSwap`, no `PoolSetupHelper`, no pool seeding). Confirms the Phase 1 helper guard works and the deploy is genuinely router-only — codex's BLOCKER resolved. Est. ~0.022 ETH.
- **Broadcast: `ONCHAIN EXECUTION COMPLETE & SUCCESSFUL`.**
- **New router: `0xa20031498AEF326773C6001fabbf5fb4b9D36B8e`.**
- Read-backs (`cast call`):
  - `feeJuicePortal() = 0x7C4176bFF969c9417e42F9CB921100145911CC84` ✓ (V5 portal)
  - `swapTarget() = 0x459EA79DdE33B415974A8355F551d0c750Fa6411` ✓ (reused swap)
  - `owner() = 0xFcc2238319aC360e985f1736aBB3df6251DAF6F5` ✓ (deployer — the Ownable2Step owner of the `sweep` valve, per codex)

## Notes
- Prior router `0x697bdb88` (V4 portal) stays deployed but orphaned — a live FJ sink for stale clients (codex's hardened note). Will be left off the manifest at promotion.
- Reused swap `0x459ea79d` has no portal dependency (bakes only poolManager/feeJuice/weth) — portal-safe reuse confirmed by codex.

`LESSONS_FILE=implementations-plan/archive/fuel-portal-v5-fix/lessons/phase-2.md`

## Phase 2: ✓ (dry-run 1-tx router-only + ONCHAIN SUCCESSFUL + 3 read-backs match)
