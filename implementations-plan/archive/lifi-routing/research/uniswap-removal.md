# Research: blast radius of removing the Uniswap V4 fuel leg

Recon agent (read-only, sonnet) over this worktree's base. File references are repo-relative; line numbers at research time. Suites counted but not read in full: FormalRouter, BlackhatAudit, the invariant suites, `useBridgeJournal.ts`, `verify:deployments`.

## DELETE / CHANGE / KEEP

### Contracts (contracts/bridge/evm)
- DELETE: `src/UniswapFuelSwap.sol`, `src/InertSwapTarget.sol`, `src/interfaces/IV4Quoter.sol`, `script/PoolSetupHelper.sol` (its `feeAssetHandler.mint` is the only on-chain use of the testnet FJ minter), `script/SeedTokenPool.s.sol`, `script/DeployFuelLive.s.sol`; in the router: `IUniswapFuelSwap` + `PoolKey`, `swapTarget` state, `setSwapTarget`, `SwapTargetUpdated`, `_swapFuel`, `_hashRoute`, `path`/`zeroForOnes`, the constructor's `_swapTarget`; `foundry.toml` v4-core remap.
- DELETE but REPLACE for the sandbox: `src/mocks/MockV4Quoter.sol`, `src/mocks/MockSwapTarget.sol` (they back the sandbox and the browser suite).
- CHANGE: `script/DeployGeneration.s.sol` (swap args); router `BRIDGE_WITNESS_TYPEHASH` / `BRIDGE_WITNESS_TYPE_STRING` / `BridgeWitness` / `_hashBridgeWitness` (drop `routeHash`, `swapTarget`; add the provider binding; keep `minFuelOutput`, `fuelAmount`) — **`bridge()` also signs `swapTarget`/`routeHash`, so plain bridges change too**; `bridgeWithFuel` + `BridgeWithFuel` (names pinned in `router-abi.ts`, `deposit-reconcile.ts`, `send-flow.ts`, `flows.ts`, the journal — keeping the names is cheaper); `RouteRequired`/identity swap → "no swap data" (fee-asset pass-through, `FEE_ASSET`, `_depositFuel`, `directGas` KEEP); `.gas-snapshot`; README.
- KEEP: `ForeignPortal`, `FuelOnlyLeg`, `InexactPull`, `_requireFactoryPortal`, `_pullTokensWithWitness`, `_depositTokens`, `sweep`; `_swapFuel`'s balance-delta checks move around the new external call.

### Forge tests
- DELETE: `MockV4Quoter.t.sol`, `RouteValidation.t.sol`, `RouteGrammarFuzz.t.sol`, `BlackhatV4Fork.t.sol`, `MainnetFuel.fork.t.sol`, `DeployFuelLive.fork.t.sol`.
- CHANGE: `SwapBridgeRouter{,Fuzz,Invariant}.t.sol`, `SwapBridgeRouterPermit2Fork.t.sol`, `WitnessHash.t.sol`, `BlackhatAudit.t.sol`, `FormalRouter.t.sol`, `mocks/RouterFixture.sol`, `mocks/RouterMocks.sol`, `TestUsdc.t.sol` (minor).
- Halmos: `_bridge-contracts.yml` hardcodes 8 `FormalRouterTest` proof names (incl. `check_bridgeWithFuel_*`, `check_setSwapTarget_revertsForNonOwner`) and the "3 proof contracts" count — mirror any rename.

### TS core (packages/bridge-core)
- DELETE: `src/route.ts`, `route-discovery.ts`, `quote.ts`, their tests, `route-conformance.test.ts`, `swap.test.ts`, `quoter-abi.test.ts`; `scripts/discover-mainnet-fuel.ts`, `scripts/smoke-swap-existing-testnet.ts`.
- CHANGE: `src/l1.ts` (witness types + encoding; byte-identical to Solidity, pinned by `l1.test.ts`), `src/router-abi.ts` (pinned against the forge artifact in CI; drop `quoter-abi` from that command), `send-flow.ts`, `send-generation.ts`, `flows.ts` (second independent `bridge()` call site), `manifest-v2.ts` (`poolV2Schema`, `tokens[].pools`, `l1.swapTarget`, the `swap` block — **`minFuelFj`/`fjPerTx`/`fjRegister`/`slippageBps` are provider-agnostic and need a new home**; `poolManager`, `quoter`, `multicall3`, `weth`, `feeJuice`, `tiers`, `ethFj` go), `scripts/verify-l1.ts` (swap-target checks, runtime-code check, witness shape), `scripts/script-l1.ts` (`assertRouterWitnessShape` asserts `includes("address swapTarget")`), `scripts/live-intent.ts` (foreign-router check reads `swapTarget`), `scripts/deploy-generation.ts` (pool seeding, swap-target deploy, `priorSwapBudgets`, swap block, `calibrate`), `scripts/generation.ts`, `scripts/deploy-manifest.ts` (journal step kinds; `.strict()` makes old journals unparseable if kinds are dropped), `scripts/gen-remappings.ts`, `scripts/deploy-seed-tokens.ts` (the "sorts below WETH" rule exists only for pool seeding), `scripts/script-send.ts`, `scripts/sandbox/*` (`deployMockSwap`, `sandboxSwapBlock`, swap-specific flows `flowNoRoute`, `flowGasOnlyWethSingleHop`, `flowMinFuelFloorBinds`), `fixtures/sandbox-manifest.json`, `test/integration/gas-leg.integration.test.ts`.
- KEEP: `gas-share.ts` (pure integer math; the quote is an input), `fuel.ts` (direct FeeJuicePortal lane), `journal.ts`, `promotion.ts`, calibration scripts (`fuel-testnet.ts` acquires FJ via the router, so its swap leg changes).

### App (apps/tools)
- DELETE/REPLACE: `useRouteQuote.ts` (+test) → a LI.FI quote composable.
- CHANGE: `useGasShare.ts` (config source only), `src/contracts/bridge-generation.ts` (`SWAP`), `useSend.ts`, `deposit-flow.ts`, `deposit-reconcile.ts` (decodes `bridgeWithFuel` calldata to recover hash-less deposits — **keep the old ABI for in-flight records**), `SendWizard.vue`, `AmountStep.vue`, `ChoiceCards.vue`, `src/lib/send-model.ts` (`GasBlock "no-route"`), `ReviewDetails.vue` ("on Uniswap v4 (N pools)", slippage row), `src/lib/bridge-steps.ts` copy, `src/lib/testids.ts` (`sendRouteStatus`, `sendReviewRoute`, `sendReviewSlippage`), browser specs/pages (`tokens.spec.ts` cells 22–23, `pages/send.ts` waits on `data-route-loading`, `pages/journal.ts` decodes the router call, `deposit-token*.spec.ts`, `accounts.spec.ts`), `tests/e2e/send-smoke.test.ts`.
- Visible copy today: "This token can't buy Aztec gas on the way in.", "This token has no usable gas route", "This network has no swap venue…", "Direct: no swap…" / "… on Uniswap v4 (N pools)…", "one signature covers the swap and the deposit". No "effective rate" UI exists.

### Manifests, ops, docs, CI
- `apps/tools/public/testnet-bridge.json`: `l1.swapTarget`, the `swap` block, `tokens[].pools: null` → CHANGE. `mainnet-bridge.json` (`bridge: null`) KEEP. `verify:deployments` CHANGE.
- Workflows: `_bridge-contracts.yml` (v4-core pins, halmos list, ABI pins, gas snapshot), `_tools-e2e.yml` (v4-core install for the sandbox's forge build) — drop the pins only after the imports are gone.
- `.claude/skills/bridge-generation/SKILL.md` steps 4, 7, 8, 9 (pool seeding, ETH/FJ pool, swap smoke, calibration prose) — rewrite in the same change or the runbook references deleted scripts.
- Root/apps/bridge-core/evm READMEs, AGENTS.md; `implementations-plan/lessons.md` (v4-core `.env` workaround) and `follow-ups.md` (forge cache entry goes with the pool scripts; the `minFuelFj` calibration entry stays).

## Answers

1. **Witness change ⇒ router redeploy, not a new generation.** Typehash/type string are constants; `swapTarget` is constructor-bound. Nothing in `PortalFactory`, `TokenPortalImpl` or Noir references the router; promotion's `assertZeroSeed` locks only network identity, factory and hub. `verify-l1 checkRouter` cross-checks `FACTORY`, `feeJuicePortal`, `FEE_ASSET`, `permit2`, witness shape. Costs: no router-only conductor command today (new tooling); users' ERC-20 → Permit2 allowances survive a router change (SignatureTransfer names the spender inside each per-send signature; the recon agent's "fresh approvals needed" claim is wrong for this flow); code-hash pins in `live-intent`/`verify-l1`; old-router in-flight records need the old ABI for recovery. SKILL.md's "all four redeploy together, always" is reset-driven, not a router constraint.
2. **Fee asset.** Testnet FJ `0x762c…3c18` is mintable via FeeAssetHandler `0x5602c39a6e9c5ace589f64f754927bcda4f4bfc9` (`fee-juice-canary-testnet.ts` calls `mint(owner)`; `mintAmount` per call; rate limits not read). Mainnet AZTEC has no handler — acquisition is a real swap. Sandbox: the fee asset is a minter-gated `TestERC20`; `ensureFeeAssetMinter` impersonates the CoinIssuer, `mintFeeAsset` mints; `deployMockSwap` pre-funds MockSwapTarget with 1e30 FJ.
3. **Gas sizing is provider-agnostic** (`gas-share.ts`: `{fjPerTx, fjRegister|fjCeilings, minFuelFj, slippageBps, rate}`; `signedMinFuelOutput = max(quote·(1−s), minFuelFj)`). The 4× `minFuelFj` rule is the FPC's surge tolerance. Consumers: `useGasShare.ts`, `SendWizard.vue`, `GasBreakdown.vue`, `deposit-flow.ts`, `script-send.ts`, `sandbox/flows-matrix.ts`, `smoke.ts`. Risk: they live in the optional `swap` block.
4. Routes/pools copy and testids: listed under App above.

## Riskiest couplings

1. Witness shape pinned in Solidity, `l1.ts`, `l1.test.ts`, `script-l1.ts`, the halmos list and the live router — a mismatch rejects every signature.
2. `bridge()` (plain sends) signs the swap fields too; `flows.ts` is a second call site.
3. Arbitrary LI.FI calldata executed from a contract holding Permit2-pulled funds: needs target/selector allowlisting plus the balance-delta + approval-zeroing discipline.
4. Recovery/journal compatibility with the old router's ABI/event names.
5. The manifest `swap` block mixes provider-agnostic budgets with V4 fields.
6. The sandbox and browser suite depend on the V4 mocks; CI pins v4-core in two workflows.
7. The testnet FeeAssetHandler is the only testnet FJ source besides swaps.
8. The operator runbook (SKILL.md) must be rewritten in the same change.
