# Recon — plan 6 faucet-cluster (read-only sweep)

## Reuse map

| Capability needed | Existing code | Verdict |
|---|---|---|
| Best-effort L2 block read after L1 receipt | `apps/faucet/src/composables/deposit-flow.ts:151-157` `bestEffortL2Block` (also used at :1021, :1123) | reuse-as-is — `useFuel.ts:270-275` duplicates the try/catch verbatim |
| Permit2 allowance/approve for the deposit token | `deposit-flow.ts:852-883` `ensurePermit2Approval(permit2, needed, recordId, l1)` — hardcodes `L1_USDC` in both the allowance read (:855-860) and approveMax write (:862-871) | adapt — add a token-address parameter; `useFuel.ts:181-212` is the same call shape with `FUEL_ASSET` |
| Router "bridge" leg: nonce/deadline → BridgeWitness → permit typed data → signTypedData → writeContract → updateRecord(depositTxHash) → awaitL1Receipt → parse event → updateRecord(leafIndex) | `deposit-flow.ts:1056-1124` `runPlainDepositLeg` (functionName "bridge") | adapt — extract the shared router-bridge span (deposit-flow :1058-1080 ≈ useFuel :217-237; :263-286 receipt/parse) |
| Deposit journal record construction | `deposit-flow.ts:759-802` `buildDepositRecord` (schema 1/2 by fuelPre, no `assetKind`) | do NOT force fuel through it — `useFuel.ts:104-127` builds a divergent literal (schema 2, `assetKind: "fee-juice"`, `fuel.minOutput: "0"`); keep a fuel-specific record builder |

## Baseline offenders (manifest)

cognitive: createAztecWalletSession.ts 3 · fuelClaim.ts 1 · useFuel.ts 1 · lib/bridge-steps.ts 1 · lib/errors.ts 1 · lib/phase-clock.ts 1 · packages/bridge-core/src/backup.ts 1
lines: createAztecWalletSession.ts 1 · useFuel.ts 2 · useL1FeeAsset.ts 1 · useWithdraw.ts 1

Per directive:
- `createAztecWalletSession.ts:128` `createAztecWalletSession` (:129-854) — 405 lines
- `createAztecWalletSession.ts:245` `readRememberedMap` (:246-266) — score 26, sync (localStorage parse/validate loop)
- `createAztecWalletSession.ts:358` `connectImpl` (:359-459) — score 57
- `createAztecWalletSession.ts:632` `requestCapabilities` (:633-699) — score 34
- `fuelClaim.ts:105` `buildFuelClaimInteraction` (:106-243) — score 26; sync builder returning `{simulate, send}` closures
- `useFuel.ts:59` `useFuelFlow` (:60-318) — 191 lines; `useFuel.ts:70`+`:71` `deposit` (:72-313) — 182 lines + score 52
- `bridge-steps.ts:63` `depositPhases` (:64-166) — score 32, fully sync view-model mapper (activeKey latch ladder :94-109)
- `errors.ts:39`, `phase-clock.ts:26` (score 22) — NOT in plan-6 scope (ACCEPTED? verify before touching)
- `useL1FeeAsset.ts:36` `useL1FeeAsset` (:37-197) — 103 lines; methods each await one read/write + receipt, `approve`/`mint` try/finally clearing flags
- `useWithdraw.ts:58` `wireWithdrawDeps` (:59-173) — 82 lines; `consume` (:81-136): getTxReceipt poll loop (:89-94) → waitForProven in try/finally clearing an interval (:103-107) → expectedWitness (:109) → simulateContract (:113) → runOnLane writeContract (:131)
- `backup.ts:73` `validateBackupRecord` (:74-155) — score 22, sync shape validator

## PR-a: createAztecWalletSession.ts

Exports: `truncateName`, `createAztecWalletSession` (factory :129-854), `parseGrantedAccounts`, `extractGrantedAccounts` alias (:922-924). The factory closes over refs (status/verificationEmojis/accounts/selectedAccount/hiddenAccountsCount/error/wallet/discoveredWallets/scanning/pickerOpen/preferredWalletName/autoReconnectDisabled/selectionNotices) + mutable locals (provider/pending/cancelDiscovery/unsubscribeDisconnect/pendingAccountChoice/nextNoticeKey/providersByKey/nextKey/epoch/activeFlowEpoch/connectingViaRemembered/ambiguityTimer) + storageKey/selectedStorageKey; returns refs + methods (:824-853). Epoch-ownership discipline documented at :121-126 — cleanup is explicit sync `cleanupSession()`/`wipeToIdle()` before/after awaits, no `finally` in the directive-bearing functions.

Await sequences:
- `connectImpl`: `for await` over `discovery.wallets` (:397) → conditional `proceedWith` (:442); branches on forcePicker / autoReconnectDisabled / per-announcement collision (`claimantsOf`) / stream exhaustion (sole claimant, picker, no-wallet error); try/catch, error path `cleanupSession()` + `releaseFlowIfOwner` sync.
- `proceedWith` (:475-513): await `chosen.establishSecureChannel` (:490); stale → await `p.cancel()` (:495); stores pending/provider BEFORE further awaits.
- `confirmVerification` (:525-567): await `flowPending.confirm()` (:538); stale → `disconnectStaleSession` (:540, awaits `flowProvider?.disconnect()` :519); else await `requestCapabilities(flowEpoch)` (:557).
- `requestCapabilities`: await `config.buildManifest()` (:638); stale → disconnect (:641); await `flowWallet.requestCapabilities(manifest)` (:650); stale → disconnect (:653); pause into `choosing-account` (return, no await) or `await finishSetup` (:698).
- `finishSetup` (:703-731): await `config.registerContracts(flowWallet)` (:709); stale → `disconnectStaleSession` (:711).
Registered promises/tokens: `pendingAccountChoice` (:170, :684) single-use pause token `{flowEpoch, wallet, provider}`; `providersByKey` Map (:187); `unsubscribeDisconnect` (:551-555).

Tests: `createAztecWalletSession.test.ts` (1141 lines, ~50 its, 10 describes: progressive discovery, selection, flow-ownership/interruption, stale-epoch SDK cleanup, remembered path, multi-account choose-on-connect, switching, parseGrantedAccounts hardening) — drives the factory via a push-driven fake discovery stream. Only other importer: `useWalletConnection.ts` (singleton wrapper).

## PR-b targets — tests
- useFuel: no unit file; `components/FuelForm.test.ts` mocks `deposit`; e2e `tests/e2e/fuel-smoke.test.ts`. `deposit` awaits: verifyPortalAsset (:95) → plan{Private,Public}FuelDeposit (:97) → conditional sealDepositRecord (:151) → ensurePermit2Allowance (:181) → signTypedData via runOnLane (:237) → writeContract via runOnLane (:240) → awaitL1Receipt (:263) → getBlockNumber (:272) → runDepositClaim (:289); finally clears busy (:309-311).
- fuelClaim: `fuelClaim.test.ts` (24 its).
- useL1FeeAsset: `useL1FeeAsset.test.ts` (15 its).
- useWithdraw: `useWithdraw.test.ts` covers only sync `buildWithdrawSendOpts` (3 its) — `wireWithdrawDeps`/`consume` unit-untested, reached via bridge-smoke.
- bridge-steps: `bridge-steps.test.ts` (~30 its).
- backup.ts: indirect via `apps/faucet/src/composables/useBridgeBackup.test.ts` (parseBackupFile/sealBridgeBackup/openBridgeBackup); no bridge-core-local test for backup.ts (search: `find packages/bridge-core -iname "*backup*"` → only src/backup.ts).

## Gates
- `apps/faucet` scripts: `test` = `bun --bun vitest run` (jsdom, excludes tests/e2e/**); `test:e2e` = `bun --bun vitest run --config vitest.e2e.config.ts` (jsdom, include tests/e2e/**, timeout 30s).
- faucet-smoke / bridge-smoke / fuel-smoke at `apps/faucet/tests/e2e/*.test.ts` — all mock wallet-sdk/chain boundaries, NO anvil / NO sandbox (faucet-smoke :13, fuel-smoke :9; bridge-smoke runs the real journal engine on jsdom localStorage). Cheap to run.
- `audit:faucet` = typecheck:all && test:faucet (unit only) && lint && verify:deployments && build:faucet.
