# Research: `packages/bridge-core` (flows, manifest, deploy conductors, quoter, journal)

Snapshot: the base branch.

## Deploy conductors + shared mechanisms

- `scripts/script-bootstrap.ts`: `sepoliaChain/mainnetChain` `:28,:38`, `createL1Clients` `:51`, `createL1PublicClient` `:73`, `createNode` `:79`, `createL2Wallet({proverEnabled})` `:83-88` (required param), `stopwatch` `:91`, `loadManifestFromConfigArg` `:102`.
- `scripts/script-l1.ts`: `ERC20_MIN_ABI` `:14`, `assertSame` `:38`, `assertRouterWitnessShape` `:46`, `assertPortalInitializerPinned` `:72`, `retryOnRevert` (Inbox subtree-full) `:92`, `ensureRouterPermit2` `:126`, `depositViaRouter` `:158`.
- `scripts/script-l2.ts`: `universalDeployInstance` `:23`, `registerManifestContract/Trio` `:39,:66` (recompute address from `{salt, args, ctor}` and **hard-stop on mismatch** `:44-46`), `claimTokensUntilSynced` `:101`, `deployerSchnorrAccount` `:139`, `sponsoredFpcFee` `:158`, `deployAccountIfAbsent` `:175`.
- `scripts/script-artifacts.ts`: `evmArtifact/evmAbi` from `contracts/bridge/evm/out` `:14,:19`.
- `scripts/run.ts`: argv-only spawn primitive (never formats/retains argv).
- `scripts/deploy-bridge-testnet.ts` (580 lines): `rebuildAndVerifyPortal` `:478-479` (committed reviewed bytes + drift alarm) → `resolveGeneration` `:140` (journal resume; per-generation salts `:150`) → signer pin `:489` → L1 token via `resolveL1Token` `:162` (`--reuse-token` or `journaledEvmDeploy` of `MintableERC20|TestUsdc` `[name, symbol, decimals, 1000n]` `:171`) → portal `:501` → L2 wallet (`proverEnabled: true`) + deployer account + `sponsoredFpcFee` `:507-528` → L2 trio `:530-554` → `wirePortal` `:251` → `runReadbacks` `:302` → `buildFuelCarry` `:359` (carries `l1.fuel` forward; `--allow-token-cutover` drops `swap` because pools are keyed by token) → `writeCandidate` `:405` → `apps/faucet/public/testnet-bridge.candidate.json`.
- `scripts/deploy-bridge-mainnet.ts` (579 lines): no token deploy (`assertCircleUsdc` `:160`); precomputes the L2 trio addresses BEFORE any L2 tx `:528-540`; `initializePortalOnce` `:190`; `depositFeeJuice` `:213`; `--l1-only` `:548`; L2 account claim-in-tx `:261`; `landL2Trio` `:322`. Pins `:62-69`: `CIRCLE_USDC`, `POOL_MANAGER 0x0000…8A90`, `V4_QUOTER 0x52F0…1203`, `WETH`, `PERMIT2`.
- `scripts/deploy-sandbox.ts` (396 lines): `anvil_setCode` Permit2 `:126-129`; `MintableERC20 → MockSwapTarget → SwapBridgeRouter → canonical TokenPortal` `:139-145`; L2 trio with `Fr.random()` salts; `--smoke` `:250-367` = router deposit → `claim_public` → `claim_private` (self) → relayer claim + wrong-recipient rejection.
- `scripts/portal-artifact.ts`: `FORKED_PORTAL_KECCAK` `:27`, `PORTAL_PIN` `:34-38`, `assertRuntimeMatchesTemplate(actual, template, expectedInitializer, immutableReferences)` `:198` (restores immutable sites, returns the decoded initializer).
- `scripts/deployer-keys.ts:32-48`: sha256 over the deployer derivation label (secret|salt, network, raw) → 31 bytes; network-tagged double wall.
- `scripts/live-intent.ts:489-628 promote`: `candidateSha256` recorded before verify; symlink rejection; `assertZeroSeed`; temp-write + rename; re-runs `apps/faucet/scripts/verify-deployments.ts` with `BRIDGE_MANIFEST=<live>`. **Live manifests are written ONLY by promote.**

## Manifest (single-token by construction)

`scripts/deploy-manifest.ts:23-58`:
```ts
export interface L2Record { address: string; salt: number; constructorArtifact: string; constructorArgs: unknown[] }
export interface CandidateManifest {
  network: string; l1ChainId?: number; walletChainId?: number
  l1: { usdc: string; portal: string; portalSource: "forked-v1"; privateClaimMode?: "salt-v2"
        token: { name; symbol; decimals; maxWholePerTx?; source?: "permissionless-mint"|"circle-proxy"; sourceContract?: "MintableERC20"|"TestUsdc" }
        fuel?: Record<string, unknown>
        feeJuice?: { portal; asset; feeAssetHandler?; minFj } }
  l2: { proxy: L2Record; token: L2Record; bridge: L2Record }
}
```
Real shape = zod `src/candidate-schema.ts:71-100` (`.strict()` everywhere): `fuel.core{router, permit2, swapTarget, swapTargetContract?, feeJuicePortal}`, `fuel.swap?{poolManager, quoter, weth, feeJuice, pools: Record<string,{fee,tickSpacing}>, slippageBps, minFuelFj}`; cross-field refinements `:139-174` (L1↔L2 token identity must agree — a drift "mis-scales every bridged amount"). `writeCandidateAtomic` parses before writing. Journal types `:91-98,121-125`. Live: testnet = TestUsdc (permissionless-mint) + full swap stack (`tokenWeth {3000,60}`, `ethFj {987,10}`); mainnet = Circle USDC (`circle-proxy`) + swap (`{500,10}` / `{10000,200}`) — the "mainnet is bridge-only" comments in `candidate-schema.ts:66-70` / `bridge-deployments.ts:74-76` are stale.

Consumers of the single-token shape: `apps/faucet/src/contracts/bridge-deployments.ts` (scalar exports + `rebuild*Instance`), `apps/faucet/scripts/verify-deployments.ts`, `src/promotion.ts`, both conductors, `buildFuelRoute`'s single `token` param.

## Fuel + swap flows

- **Direct Fee-Juice** `src/fuel.ts`: `planPublicFuelDeposit` `:159`, `planPrivateFuelDeposit` `:167` (`to = PRIVATE_FPC_ADDRESS`, secret = `deriveBridgeSecret(salt, claimer)`), `feeJuiceDepositArgs` `:174`, `parseFeeJuiceDeposit` (leaf index from the portal's own event) `:184-193`, `assertFuelClearsFloor` (fails CLOSED) `:195-206`, `buildCarrierlessFuelClaimPayload` `:213`. FeeJuicePortal has no private deposit variant; privacy is an L2-claim concern.
- **Swap-bridge** `src/flows.ts:332 runSwapBridge`: sign witness → `bridgeWithFuel` → read both leaf indices from the `BridgeWithFuel` event. `assertPrivateFuelInvariants` `:304-321` fail-closed; Grumpkin-point check on recipient `:341`; private path zeroes `aztecRecipient` on-chain `:369-371` (indexed event field).
- `src/private-fuel.ts`: `DOM_SEP__FPC_BRIDGE_SECRET = 3952304070` literal `:235-242`; `PRIVATE_FPC_ADDRESS` `:263`; `deriveBridgeSecret` `:274`; `privateMintAndPayFee` `:288`.
- `src/route.ts:141 buildFuelRoute`: fixed 2-hop `token → WETH → native ETH → FeeJuice`; address-sorts pools, derives `zeroForOne`; hooks always zero.
- `src/l1.ts`: `BRIDGE_WITNESS_TYPE` `:11-14` (12 fields), `hashRoute` `:41-60`, EIP-712 types `:76-102`, `hashBridgeWitness` `:121`, `PERMIT_DEADLINE_SECONDS = 600n` `:163` (pinned), `ensurePermit2Allowance` `:176`.
- `src/router-abi.ts`: hand-written ABI pinned to the forge artifact by `router-abi.test.ts`.
- `src/quote.ts` (99 lines): V4 Quoter `quoteExactInputSingle` via `eth_call` (nonpayable by design) `:12-44`; `quoteFuelPath` chains hops `:236`; `QuoteUnavailableError` `:228` on revert or zero; `minOutputForSlippage` `:257`. Consumers: `apps/faucet/src/composables/deposit-flow.ts:720 prepareFuelSlice`, `apps/faucet/src/components/BridgeForm.vue:161`, scripts. `discover-mainnet-fuel.ts` sweeps `FEE_TIERS = [{100,1},{500,10},{3000,60},{10000,200}]` via `PoolManager.extsload` slot0 then proves with dust quotes ("initialized ≠ liquid").

## Journal / recovery / backup

- `src/journal.ts`: key `unleashed-bridge:journal:v1` `:26`, `MAX_RECORDS = 100` `:30`; `JournalBase` `:35-57` = `{schema, id, direction, isPrivate, amount, createdAt, updatedAt, completedAt?, chainId, portal, bridge}`; `DepositJournalRecord` `:104-136` adds `assetKind?: "bridge-token"|"fee-juice"`, `recipient`, `secret?`, `sealedEnvelope?`, `secretHashHex`, `sealerL1?`, tx hashes, `leafIndex?`, `messageHash?`, `depositL2Block?`, `fuel?: DepositFuelBlock` `:60-102`; `WithdrawJournalRecord` `:138-145`. Deployment binding `{chainId, portal, bridge}` `:53-56` — a record from another deployment refuses resume; direct-Fuel binds `{portal: FeeJuicePortal, bridge: L2 FeeJuice}` `:107-109`. **No token field** — "which token" is resolved by the binding matching the loaded manifest. `capRecords` `:191` never evicts unfinished records.
- `src/recovery-crypto.ts`: per-record key `recoveryKeyMessage({chainId, portal, bridge, secretHashHex})` `:27`; `DepositEnvelopeV2` `:107-119`; `sealDepositRecord` `:171` (untrusted sealer → two-signature determinism self-test before the irreversible tx).
- `src/backup.ts`: `BridgeBackupFile` `:16-27` `{format, v, chainId, portal, bridge, direction, id, sealerL1, blob}`; `validateBackupRecord` `:74` strict; `openBridgeBackup` `:187`.
- `src/seal-trust.ts`: key `unleashed-bridge:seal-trust:v1` `:293`, entries `${chainId}:${address}` `:315`.

## Tests (34 vitest files, `bun --bun vitest run`)

Keystones: `content-hash.test.ts`, `claim-secret.test.ts`, `private-fuel.test.ts`, `l1.test.ts` (witness/route ↔ Solidity), `router-abi.test.ts` (`describe.skipIf(!existsSync(ARTIFACT))`), `noir-artifact-classids.test.ts`. Others: `backup`, `candidate-schema`, `fee-juice`, `flows`, `fuel`, `journal`, `l1-receipt`, `progress`, `promotion`, `quote`, `recovery-crypto`, `relay-claim`, `reuse-token`, `route-conformance` (TS restatement of `_validateRoute`, explicitly not differential), `route`, `seal-trust`, `status`, `swap`, `withdraw`; scripts: `deploy-canonical-private-fpc`, `deploy-manifest`, `deployer-keys`, `portal-artifact` (`describe.skipIf(!PORTAL_RUNTIME_CAPTURE)`), `run`, `script-bootstrap`, `script-l1`, `script-l1.deposit`, `script-l2`. **No env-gated live-network vitest suites**; live validation = operator scripts (`smoke-existing-testnet.ts`, `fuel-testnet.ts`, canaries, `verify-l1.ts`).

`vitest.config.ts`: node env, `setupFiles: ["./src/test/setup.ts"]` (aliases `self = globalThis`). Tests must import from `vitest` (bun:test lacks `expect.addEqualityTesters`).

## `.env.example`

Required `PRIVATE_KEY`, `SEPOLIA_RPC_URL`; optional `AZTEC_NODE_URL`, `ETHERSCAN_API_KEY`, `FORGE_BIN`, `CAST_BIN`. Referenced elsewhere but undocumented: `MNEMONIC`, `MAINNET_PRIVATE_KEY`, `ETH_RPC_URL`, `BRIDGE_DEPLOYER_SECRET_{TESTNET,MAINNET}`, `TOKEN_*`, `SWAP_TARGET_CONTRACT`, `FUEL_MIN_FJ`, `FJ_BRIDGE_AMOUNT`, `SANDBOX_L1_RPC`, `SANDBOX_NODE_URL`, `BRIDGE_MANIFEST`, `PORTAL_RUNTIME_CAPTURE`.

## Implications

- Manifest becomes generation-level (factory, implementation, hub, feeJuice, fuel core/swap) + a `tokens[]` array for pre-created blue chips; the frontend derives per-token L2 instances from `(erc20, name, symbol, decimals)` rather than reading them from the file.
- Journal gains `token: { erc20, symbol, decimals, portal, l2Token }`; binding becomes `{chainId, factory, hub}` + per-record token; backup header + `recoveryKeyMessage` domain must include the token to keep per-record key isolation.
- `route.ts`/`quote.ts` generalize to candidate-route sets per token (tiers × shapes) with a first-class `no-route` outcome distinct from `QuoteUnavailableError`.
- `flows.ts` gains a fuel-only path (`fuelAmount == totalAmount`) and the portal is derived (`predictDeterministicAddress`) rather than read from config.
- The deploy conductor collapses to: L1 (fake tokens on testnet) → implementation + factory → L2 classes + hub → `bind_l1` → pre-create blue chips (L1 `createPortal` + L2 `register`) → candidate manifest.
