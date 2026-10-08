# Research (lead): sandbox, browser harness, send pipeline, operator tooling

Lead-planner round, one read-only mapping agent. File references are repo-relative; line numbers at research time. `BC` = `packages/bridge-core`, `AT` = `apps/tools`.

## Sandbox L1

- One anvil per run (`BC/scripts/sandbox/local-network.ts` `spawnAnvil`, chain 31337, 16 accounts, own process group); ports from `~/.agents/ports.md` (`reservePort`, `claimSandboxPorts`). **No second-chain support anywhere.**
- Vendored bytecode: `bytecode/permit2.json`, `bytecode/multicall3.json` only, installed by `copyCanonicalCode` (`l1.ts`, keccak re-checked). Permit2's runtime caches its chain id, so a second chain needs its own check (Permit2 rebuilds the domain separator when `block.chainid` differs, M).
- Deploy order (`deploy.ts` `deployEverything`): canonical code → L2 actors / guardian / PrivateFPC → node-reported `feeJuice`, `feeJuicePortal`, `registry` → `deployL1Fixtures` (`MockSwapTarget` at rate 1e12:1, fee-asset minter impersonation, 1e30 FJ to the mock, five `MintableERC20`s, `MockV4Quoter` + `setRoutable`) → `deployGeneration` (`generation.ts`: factory, `deployRouter` with `[permit2, feeJuicePortal, swapTarget, factory]`, hub) → pre-create usdc/usdt/pxo → drip → `buildManifest` (`sandboxSwapBlock`) + `handle.json` (`swapTarget`, `quoter` required).
- Flows depending on the V4 mocks: `flowTokenPlusGas`, `flowNoRoute`, `fundedSendFor` users, and the matrix cells `flowTokenPlusGasWithCreditHeld`, `flowTokenPlusGasPrivate`, `flowMinFuelFloorBinds`, `flowGasOnlySwapped`, `flowGasOnlyWethSingleHop`, `flowDiscoveredRouteSend`, the `*WithPublicFjHeld` variants; `smoke.ts` ~32 steps.
- Integration (`BC/test/integration`, `BRIDGE_INTEGRATION=1`, `vitest.integration.config.ts`, serial, 600 s): suites `deposits`, `gas-leg` (V4), `fee-states` (partly V4), `exits`, `registration`, `drip`.

## Browser suite

- `AT/scripts/e2e/agent.sh` boots `sandbox:up`, builds the local target + test wallet, runs Playwright (one worker); sharding = separate runs, each with its own sandbox.
- `fixtures/l1-wallet.ts`: `window.ethereum` backed by an exposed Node function over **one** `rpcUrl`; `wallet_switchEthereumChain`/`setChainId` only change the `eth_chainId` answer; every read still hits the one anvil. Controls: `rejectNext`, `holdNext`, `permits()`, `calls()`.
- `fixtures/egress.ts`: one `context.route("**/*")`: token-list URL fixture-answered, loopback continued, everything else aborted and the test fails on any blocked request. A CSP-blocked request never reaches the route handler.
- Fuel-leg specs: `spike`, `deposit-token-gas`, `deposit-gas-only`, `tokens` (cells 22–23: route + slippage review rows), `recovery` 24a, `activity`; `setRoutable` calls in `deposit-token`, `activity`, `registration-retry`. `pages/send.ts goToReview` waits on `data-route-loading`; `pages/journal.ts depositCalldata` decodes the router ABI expecting `bridge`/`bridgeWithFuel`.

## App send pipeline (Ethereum-origin today)

`useSend.send` → `performSend` (`assertL1Chain`, `ensureSendGrant`) → `executeSend`: `prepareSecrets` → `openSendRecord` (record written, then `sealSend` for private) → `ensurePermit2Approval` (`approve(permit2, max)`, hash journalled) → `runSend` (`BC/src/send-flow.ts`: `onSecrets` → `persistPreTx` before the signature, `buildWitness` with `swapTarget`/`routeHash`, `signTypedData`, `writeContract`, receipt, `readLeaves` from the router's `Bridge`/`BridgeWithFuel`, `readRegistration`) → `afterReceipt` → `runDepositClaim` (`useBridgeJournal.ts`: guards, `reconcileDepositLeg` when the leg is missing, unseal, readiness gates, `sendAndWatch`).

- Single-chain everywhere: `NETWORK.l1ChainId`/`viemChain` in `useL1Wallet.ts`, `deposit-flow.ts`, `useSend.ts`, `useTokenCatalog.ts`, `useBridgeJournal.ts`, `useBridgeBackup.ts`; the Permit2 domain uses `SendGeneration.chainId`.
- `useL1Wallet.publicClient` uses a `custom` transport through `window.ethereum` because the CSP refuses HTTP RPC; `wrongChain`/`switchL1Network` assume one L1.
- `deposit-reconcile.ts findDepositTx`: router-specific (`tx.to == router`, `calldataMatches` decodes `bridge`/`bridgeWithFuel`), window from `createdAt − 600 s` capped at 50k blocks, budgets (45 s, 200 reads, 8 candidates), `"ambiguous"` on > 1 match.

## UI surfaces touched today by route/fuel/source

`DirectionSegment.vue` ("Ethereum → Aztec"), `TokenStep.vue`/`TokenList.vue` ("paste its Ethereum address"), `AmountStep.vue` (`RouteKind`, `data-route-loading`, `routeLine`), `lib/send-model.ts` (`GAS_BLOCK_REASON`), `ChoiceCards.vue`, `GasBreakdown.vue`, `ReviewStep.vue`, `ReviewDetails.vue` (Route row "… on Uniswap v4 (N pools)…", Slippage row, testids `sendReviewRoute`/`sendReviewSlippage`), `SendWizard.vue` (route quote wiring, "This network has no swap venue…", min-gas refusal), `lib/bridge-steps.ts` (phases and copy: "one signature covers the swap and the deposit", "the fuel swap rides along…"), `BridgeStepper.vue` (headline "Ethereum → Aztec"), `BridgePhaseRail.vue`, `BridgeJournalCard.vue` (recovery copy), `BridgeReceipt.vue` (From row hard-codes "Ethereum"), `BridgeFooter.vue` ("Router" link), `L1WalletPanel.vue` ("Switch to …").

## CSP / network

`AT/src/lib/network.ts` is the only `viem/chains` importer (Biome `style/noRestrictedImports`, `biome.json` override exempting that file). `network-targets.ts cspConnectSrc`: local = loopback + wallet origins + token list; testnet = the node URL + token list; mainnet = `'self' data: blob:`. `vite.config.ts` writes `_headers` from it.

## Operator tooling that names the swap target

- `verify-l1.ts`: `SWAP_TARGET_ABI`, `checkRouter` → `assertRouterWitnessShape` (`script-l1.ts`, asserts `address swapTarget` in the type string), `checkSwapTarget`, `checkGeneration` deployed list, `CODE_TARGETS` (`swapTarget: UniswapFuelSwap`), `checkCodeHashes`, `verifyL1Manifest` (`swap?.multicall3`).
- `live-intent.ts`: `verifyGenerationBindings` reads `router.swapTarget` and the router owner; `CAPS.maxWethSeed` (pool seeding) becomes dead; signer pins unchanged.
- `generation.ts`: `GenerationInputs.swapTarget`, `deployRouter` args, `readRouterBindings`. `deploy-generation.ts`: `deploySwapTarget`, `seedPool`, `commandCalibrate` (writes `swap.fjPerTx`/`fjRegister`). `deploy-manifest.ts` step kinds include `swap-target-deployed`, `pool-seeded` (keep parseable for old journals). `promotion.ts` is router-agnostic.
