# sdk-1 recon

Base: `main` at `fb90e366`. Three Sonnet explorers (bridge-core export map, app flows, the mainnet fuel-only path) plus
the driver's own spot checks. Paths are repo-relative; `bc:` is `packages/bridge-core/src`.

## Reuse map

| Capability the lane needs | What exists | Verdict |
|---|---|---|
| L1 deposit leg, every intent (token, token+gas, gas) | `bc:send-flow.ts` `runSend` (:283): Permit2 witness sign, `bridgeWithPermit`, receipt, leaves from mined `Deposited`; hooks `onSecrets`/`onSent`/`onConfirmed` (:104-116), `SendStage` (:45) | adapt: split build from sign/send, keep the leaf logic |
| Permit2 typed data, allowance | `bc:l1.ts` `depositWitnessPermitTypedData` (:111, pure), `ensurePermit2Allowance` (:144, injected callbacks) | reuse as-is |
| L2 claim (register-if-first, race retry, private two-tx) | `bc:hub-l2.ts` `claimViaHub` (:325), `hubTokenFor`, `SendOpts` hooks (:92-100, `Record<string, unknown>`) | adapt: type `SendOpts`, keep the decision logic |
| Fee payer ladder (public Fee Juice, PrivateFPC mint/credit, own gas, spike split) | app `composables/deposit-flow.ts` `resolveHubClaimSendOpts` (:898), `resolvePrivateFuelFee` (:495), `resolvePublicClaimFee` (:777), `ownGasFee` (:729); `lib/fuel-claim-state.ts` `decideOwnGasSource` (:213); `lib/wallet-fee-budget.ts` `walletMaxFees` | move into the SDK (Vue-free today) |
| Gas-only claim (carrier-less) | app `composables/fuelClaim.ts` (:104, :161, :232), `bc:fuel.ts` `buildCarrierlessFuelClaimPayload` (:99) | move |
| Fee Juice payment methods | `bc:fee-juice.ts`, `bc:private-fuel.ts` (constants, `privateMintAndPayFee`, `privateFeeJuicePayment`) | reuse |
| Direct Fee Juice portal deposit (fee asset only) | `bc:fuel.ts` `planPublicFuelDeposit`/`planPrivateFuelDeposit` (:42, :50), `feeJuiceDepositArgs`, `parseFeeJuiceDeposit` | reuse |
| Swap to AZTEC (fuel quote) | `bc:fuel-quote.ts` `lifiFuelProvider` (:154), `testnetSwapperFuelProvider` (:199), `manifestFuelProvider` (:253); `bc:lifi-api.ts` keyless client over `bc:capped-fetch.ts` | adapt: provider selection must not need `bridge` |
| Gas share math | `bc:gas-share.ts` | reuse |
| Withdraw consume | `bc:flows.ts` `consumeWithdrawal` (:167) | reuse (exits stay out of the SDK's v1 flows unless the owner adds them) |
| Status / progress | `bc:progress.ts`, `bc:status.ts` (no importer outside their tests); the app's step model is derived from persisted record + runtime (`lib/bridge-steps.ts` `stepperPhases` :123, `useBridgeJournal.ts` `BridgeStep` :108) | build new: typed event union; the app maps events onto its journal |
| Persistence (journal, seals, backup) | `bc:journal.ts`, `bc:backup.ts`, `bc:recovery-crypto.ts`, `bc:seal-trust.ts` (KV-injected); app engine `useBridgeJournal.ts` (2316 lines) | stays app-side; the SDK takes an awaited persist hook |
| Manifest | `bc:manifest-v2.ts` (strict zod, re-derives every address) | adapt: a fuel-only shape |
| Errors | three classes (`Erc20MetadataError`, `ScanIncomplete`, `LzOptionsError`), 143 plain `Error`s, typed refusal unions (`FuelQuoteRefusal`, `LifiRefusal`, `RouteRefusal`, `CappedFetchRefusal`) | build new: one tagged error type at the public boundary |
| Publishable build | none: every package exports `.ts` source, `noEmit` tsconfigs, no bundler in the repo | build new |
| Sandbox integration | `bc` `test:integration` (anvil + local network + generation + cross-chain cells), `scripts/sandbox/` | reuse the harness |
| Fork tests | `contracts/bridge/evm/test/LifiDestinationFork.t.sol` (`test_fuelOnly_consumesTheSliceExactly` :102, mainnet fork, real Diamond + FeeJuicePortal), `DepositRouterPermit2Fork.t.sol` (`test_identity_fuelOnly` :174, mocks), `FakePortalFactory` mock | adapt |
| Router deploy | `bc` scripts `generation.ts` `deployDepositRouter` (:633, generic); `generation-router.ts` refuses chain 1 (:119-123); `live-intent.ts` mainnet signer pinned (:52-57), all else testnet | adapt |

## Verify-first answers

1. **Exports.** `bc:index.ts` re-exports 49 modules. Flow logic: `send-flow`, `hub-l2`, `flows`, `fuel`, `fuel-quote`,
   `crosschain-route`, `l1`, `l1-receipt`, `hub-token`. Pure protocol: ABIs, derivations, `manifest-v2`, `lifi-decode`,
   `lifi-addresses`, `gas-share`, `fee-juice`, `private-fuel`. App state: `journal`, `backup`, `recovery-crypto`,
   `seal-trust`, `token-list` (all KV-injected; no `window`/`localStorage` in code). Ops: `promotion`, `drpc-node`
   (`process.env`). No `node:` import; `Buffer` only as a type (`bc:flows.ts:61`). `bc:artifacts.ts:6` imports the hub
   artifact from `contracts/`, outside the package. Most orchestration is not in bridge-core: it is in the app's
   `useSend.ts` (892 lines), `deposit-flow.ts` (1034), `fuelClaim.ts`, `useHubExit.ts` (648) and the journal engine.
2. **Fuel-only router.** `DepositRouter` needs a non-zero `factory` (constructor :115) and calls
   `FACTORY.depositsPaused()` on every entry (:235); `createPortal` only on a token leg (:253, :266). The hub is never
   referenced. Fuel-only is an intent shape (`fuelSlice == amount`, no token secret). So the router runs fuel-only
   against a factory that answers `depositsPaused()` alone; a token leg would then revert at `createPortal`. What is
   missing: that stand-in, a manifest shape (top level is `.strict()`; router fields live only in `bridge.l1`, which
   requires factory, implementation and hub), `sendGenerationOf` (requires `bridge`), `readSendInbox` (reads the
   factory's `INBOX`/`ROLLUP_VERSION`; the canonical `FeeJuicePortal` exposes `INBOX()` and `VERSION()` itself), a
   mainnet branch of the router-only conductor (Diamond as swap target, no `TestnetFuelSwapper`), `verify-l1`
   (`requireBridge`), `live-intent` mainnet scope, mainnet fuel budgets, a runbook section.
3. **ask3's claim holds, and is wider.** `apps/tools/src/composables/useFuelQuote.ts:54` passes no LI.FI client, and no
   `LifiClient` is built anywhere in the app. Also: `manifestFuelProvider` returns `undefined` on `bridge: null`
   (`bc:fuel-quote.ts:258`), the mainnet build is a static placeholder (`App.vue`, `MAINNET_TARGET` with no node and no
   read RPCs), and no build's CSP admits `li.quest` (`lib/network-targets.ts:122-152`).
4. **Wallet surface.** The app uses the standard surface: `requestCapabilities`, `getAccounts`, `registerContract`,
   `simulateTx`, `sendTx` (through aztec.js `.send()`), `executeUtility`, `createAuthWit`; `registerToken` and
   `isTokenRegistered` fail open; `grantPublicAuthwit` is not called. aztec.js 6.0.0's `Wallet.sendTx(exec:
   ExecutionPayload, opts)` takes encoded calls, so an SDK can hand a wallet a payload it built. It cannot drop the
   wallet object for the claim: the register decision is a simulate at claim time, the private first claim waits for
   the registration to be visible to the claimer's wallet, and the fee ladder reads the wallet's fee settings.
5. **Effect 4.** `effect` 4.0.0 is the first 4.x release; 4.0.5 clears the 7-day gate at planning, 4.0.6/4.0.7 do
   not. Unpacked 54 MB, zero runtime deps. The `my-stack` skill: suggest it for services with concurrent loops and
   time-dependent logic; skip it for UI and around promise APIs that cannot be cancelled (`proveTx`); adopt at the edges.
6. **Publishing under Bun 1.4.2 + isolated linker.** `bun build` emits no declarations; TypeScript `^6.0.3` is in the
   repo. Source uses extensionless relative imports under `moduleResolution: Bundler`, which emitted ESM cannot keep for
   Node consumers. The isolated linker resolves only declared deps, so the SDK must declare every import
   (`packages/bridge-core/scripts/layout-identity.test.ts` is the existing guarantee). `@aztec-labs/*` classes
   (`AztecAddress`, `Fr`) are nominal, so a consumer's copy and the SDK's must be the same: peer dependencies.

## Facts that bound the plan

- Mainnet Aztec runs the Alpha 5.0.1 line (`MAINNET_ROLLUP_VERSION`, `private-fpc-canonical-mainnet.json`,
  `mainnet-bridge.json` `privateFpc.version`); this repository pins 6.0.0. An L2 claim on mainnet from this line is
  unproven until Alpha upgrades (`implementations-plan/follow-ups.md`, "Mainnet stays on its line").
- `PRIVATE_FPC_ADDRESS` (`bc:private-fuel.ts:37`) is one constant; mainnet's FPC is another address. The app uses the
  constant in `deposit-flow.ts`, `fuelClaim.ts`, `lib/fuel-target.ts`, `lib/capabilities.ts`. A private fuel deposit on
  mainnet through the constant would name the wrong claimer contract.
- The browser suite: 16 specs, 78 tests, about 61 minutes of work in six CI shards, local build only, egress closed
  except the token list; no li.quest fixture exists. Fork suites never run in CI (`_bridge-contracts.yml:50`).
- CI path filters (`pr-quick.yml` `tools`) name `packages/bridge-core/src/**`; `scripts/ci-cd/behavior-gating.test.ts`
  pins them. A new package needs the filters and the pin.

## Collisions

- **relayer-1** imports bridge-core's Across exports (`across-v4`, `across-self-built`, `across-api`) and the logic
  of `bc` `scripts/fill-testnet.ts`, which imports `../src/lifi-addresses` by relative path.
- **terms-1** edits `apps/tools` shell and routing; the mainnet placeholder (`App.vue`) is its surface too.
- **mainnet-1** (later) builds a gas-only mainnet app on the SDK's fuel flow.
- Open issues: none. Closed known limits: #27 (rc.3 factory unpaused), unrelated. `follow-ups.md` entries this lane
  touches: "The app never hands its fuel provider a LI.FI client" (ask3), "One fork test for Ethereum-origin sends
  through real LI.FI", "Mainnet stays on its line", "`fuel.crossChainSlippageBps` has no reader".
