# Recon — lifi-routing

Two read-only recon agents over this worktree's base (a reuse sweep across 12 capabilities, and a blast-radius map for removing the Uniswap V4 fuel leg — detail in [research/uniswap-removal.md](research/uniswap-removal.md)). Round-1 provider research lives in [research/](research/). File references are repo-relative; line numbers at recon time.

## Reuse map

| Capability needed | Existing code | Verdict |
|---|---|---|
| Exact pull, balance delta, `forceApprove`→0, exact debit | `SwapBridgeRouter.sol` `_pullTokensWithWitness`, `_swapFuel` checks, `_depositTokens`, `_depositFuel`, `_requireFactoryPortal` (virtual, overridden by mocks); `TokenPortalImpl._pullExact`; `PortalFactory.createPortal/predictPortal` | **adapt** — extract a shared abstract base for router + adapter rather than copy (dedup risk 1); "measure, then split" replaces strict equality in the adapter |
| Swap provider seam | `IUniswapFuelSwap`, owner-rotatable `swapTarget` bound in the witness, `InertSwapTarget` (non-zero "swap disabled" slot), `setSwapTarget` `nonReentrant`, router re-checks the signed floor itself | **build new** interface (target + calldata), keep the posture: allowlisted target, witness-bound calldata hash, router-enforced floor, balance-delta + exact-consumption checks |
| Permit2 witness (TS + Solidity) | `packages/bridge-core/src/l1.ts`, `router-abi.ts`, `BRIDGE_WITNESS_TYPEHASH`/type string, pinned by `l1.test.ts`, `WitnessHash.t.sol`, `router-abi.test.ts`, `script-l1.ts assertRouterWitnessShape` | **adapt** in lockstep (struct bump); `bridgeWitnessPermitTypedData`, `ensurePermit2Allowance`, `PERMIT_DEADLINE_SECONDS` reuse as-is |
| Gas sizing math | `gas-share.ts` (`proposeGasShare`, `signedMinFuelOutput`, rate `{probeIn, probeOut}`), `useGasShare.ts`, `minOutputForSlippage` | **reuse as-is** (quote is an input); budgets need a new manifest home outside the V4 `swap` block |
| Quote / route discovery | `quote.ts` (V4 quoter, Multicall3 batch), `route.ts`, `route-discovery.ts`, `useRouteQuote.ts` | **build new** LI.FI quote client; keep `RouteOutcome` (`route | identity | no-route | unavailable`) as the UI contract and `useRouteQuote`'s debounce + latest-wins + "answer carries its question" pattern |
| Leaf + amount discovery, message auth | `send-flow.ts readSendReceiptLeaves` (router events, emitter-filtered), `fuel.ts parseFeeJuiceDeposit` (reads FeeJuicePortal event — **no emitter filter today**), `factory-abi.ts TOKEN_PORTAL_ABI` (declares `DepositToAztec*` events), `message-nullifier.ts`, `l1-to-l2-readiness.ts`, `l1-receipt.ts awaitL1Receipt`, `deposit-reconcile.ts` (router-specific `findDepositTx`, reusable budgeted reads + `chainEpoch`) | **adapt**: an emitter-filtered portal/adapter-event matcher keyed on secret hashes returning a candidate set; reuse hash recomputation for authentication; never write a second FeeJuice leaf parser |
| Journal / stepper / backup | `journal.ts deriveSendDepositStage` (facts-only), `backup.ts validateSendRecord/assertDepositFacts` (every optional field type-checked), `useBridgeJournal.ts BridgeStep` + `bridge-steps.ts LOG_PHRASE` (exhaustive), `BridgePhase["key"]`, `DEPOSIT_ESTIMATES`, `record-policy.ts`, attention sets; `recovery-crypto.ts`, `seal-trust.ts` | **adapt** (additive within journal schema 3); recovery-crypto + seal-trust **reuse as-is**; `DepositEnvelopeV2` amount commitment needs rethinking for a measured amount |
| Chains, network, wallet clients | `network.ts` (`VIEM_CHAINS`: sepolia/mainnet/foundry; Biome exemption already covers this file), `network-targets.ts` CSP, `useL1Wallet.ts` (reads proxied through `window.ethereum` because CSP blocks HTTP RPC), `manifest-v2.ts` (`.strict()` everywhere) | **adapt** + **build new** source-chain registry; RPC origins must enter CSP per target |
| Token catalog + balances | `token-list.ts` (already `chainId`-parameterised; the pinned list carries Base/Arb/OP rows), `useTokenCatalog.ts` (hardcodes `MANIFEST.l1ChainId`), `useRowBalances.ts` (keys `${chainId}:${address}`), `erc20.ts readErc20Balances` (Multicall3; exists on Base/Arb/OP) | **adapt** (chain selector, one client per chain) |
| L2 Fee Juice + claims | `fee-juice.ts`, `private-fuel.ts`, `fuel.ts`, `hub-l2.ts`, `fuelClaim.ts` | **reuse as-is** — amounts must be the measured landed amounts |
| Test harnesses | forge fork suites (`vm.envOr` RPC + `vm.skip`), `MainnetFuel.fork.t.sol` warning (assert deltas), `GenerationDeployer` in `DeployGeneration.s.sol`, `RouterFixture`/`RouterMocks`/`AztecFakes`; sandbox `scripts/sandbox/*` (single anvil 31337; vendored bytecode for Permit2/Multicall3 via `anvil_setCode` — immutables/constructor storage not reproduced); browser `fixtures/l1-wallet.ts` (one RPC, fakes `wallet_switchEthereumChain`), `egress.ts` (non-loopback aborted; fixture-answers the token list) | **adapt**; dual-chain sandbox and a LI.FI route fixture are **build new**; prefer deploying LI.FI's open-source Executor/receiver in the sandbox over `setCode` |
| Operator tooling | `generation.ts` (journaled resumable deploys; `deployRouter` is the template), `deploy-manifest.ts` step kinds (`.strict()`), `verify-l1.ts CODE_TARGETS` + `checkRouter`, `live-intent.ts` (`PLAN_PINNED_L1_SIGNERS` per network, CAPS in ETH), canaries, `*.env.example` (`op://Keyed-Runs/…`) | **adapt**; a source-chain signer and Base Sepolia RPC are new concepts |
| Third-party HTTP client | `token-list.ts fetchCatalog` (redirect `error`, 8 s timeout, streaming byte cap, SHA-256 pin, zod, never throws) | **adapt**: extract `readCapped` + timeout + redirect policy into a shared helper; drop the digest; fail closed for quotes; re-verify calldata locally |

## Absences (search trails)

- No LI.FI code anywhere: `grep -rniwE 'lifi|li\.fi|lifinance'` over apps, packages, contracts, scripts, audit, implementations-plan, root `.md` (only this plan's research files).
- No multi-chain source-asset code: `grep -rn "Base\|Arbitrum\|Optimism"` in `apps/tools/src`, `packages/bridge-core/src` (only sandbox + viem chain list).
- No measured-balance deposit helper or refund-on-failure path: `grep -rn "balanceOf(address(this))" contracts/bridge/evm/src` + the `src/` listing.
- `token-sprite.ts` does not exist (`find . -ipath '*sprite*'`; marks keyed by `logoKey` in `TokenTile.vue`/`TokenList.vue`/`TokenStep.vue`); `quoter-abi.ts` does not exist (ABI in `quote.ts`).

## Conventions to match

Biome (tabs, no semicolons, double quotes, `noExplicitAny` error); cognitive complexity ≤ 15 and ≤ 80 non-blank lines per production function (baseline shrink-only); comments state invariants only, never plans/phases; TSDoc on public APIs; Solidity `pragma >=0.8.27`, solc 0.8.28 via_ir, custom errors, `@oz/` remaps, `forceApprove`→0, `nonReentrant`; hand-written TS ABIs pinned to forge artifacts by tests; `*.pins.test.ts` byte pins; forge suites named `Formal*`/`*Fork`/`*Fuzz`/`*Invariant`; composables singleton + `dispose()` + latest-wins `seq`; journal-first latch (record written before any wallet call); isolated linker (declare every import); 7-day dependency age gate.

## Collision / dedup risks

1. Router and adapter duplicating `_pullTokensWithWitness`, `_depositTokens`, `_depositFuel`, `_requireFactoryPortal` — extract a shared base (mind the `virtual` overrides in mocks).
2. Witness defined in TS, Solidity and `deposit-reconcile.ts calldataMatches` — extend the pin tests.
3. Constructor args spelled in `GenerationDeployer`, `generation.ts` and the sandbox `deploy.ts`, plus `verify-l1 CODE_TARGETS` — the adapter goes into all four.
4. `.strict()` manifest: every committed manifest, fixture and sandbox `buildManifest` change together.
5. `SEPOLIA_RPC_URL`, `NETWORK.l1ChainId`, `deploymentMatches`: `JournalBase.chainId` must keep meaning "the destination L1".
6. `parseFeeJuiceDeposit` lacks an emitter filter — a hostile-token hazard once one tx carries logs from several contracts.
7. Name collisions: `SwapBridgeParams`, `runSwapBridge`, `SwapFlowStage`, `runRouterDeposit` (flows.ts), `SwapBlock` (two definitions), `swapTarget` everywhere — prefer `DepositAdapter`, `LiFiRoute`, `bridging`.
8. `BridgeStep`/`LOG_PHRASE` exhaustive; `BridgePhase["key"]` consumed by `BridgeStepper.vue`, `BridgeJournalCard.vue`, browser `pages/journal.ts`/`send.ts`; testids in `src/lib/testids.ts`.
9. The research fork proofs under `research/fork-proofs/` are references, not suites: their imports (`../src/...`), pinned blocks and public RPCs must be reconciled before any of it moves under `contracts/bridge/evm/test`.
