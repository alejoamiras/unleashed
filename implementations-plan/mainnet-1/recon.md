# mainnet-1 recon

Base: `main` at fb90e36. Two Sonnet explorers (app build targets and gas flow; Drip and the mainnet deploy surface),
plus the driver's own checks, including read-only calls to keyless public endpoints. No key was used; no `.env` file
was read. Sibling plans were read with `git show worktree-<lane>:…` only.

## Reuse map

| Capability | Existing code | Verdict |
|---|---|---|
| Build-target selection | `apps/tools/vite.config.ts` `makeToolsConfig` (:135-199) defines `VITE_TOOLS_TARGET` and inlines the target's manifest; `src/lib/network-targets.ts` `MAINNET_TARGET` (:163-179) | adapt: mainnet gains a node, a read RPC and the CSP origins |
| What mainnet renders | `src/App.vue:16` mounts `MainnetPlaceholderView` when `IS_MAINNET`; `main.ts:34` skips the node probe; terms-1 a1 moves this to a literal `MAINNET_BUILD` test and an async placeholder | adapt: mount the shell when the manifest has a route |
| Build verification | `scripts/verify-build-target.ts:26-66` (target, chain id, manifest digest, exact `connect-src`); terms-1 adds `legal-dist.ts` | adapt: one more check, "a mainnet manifest has no token route" |
| No-route predicate | `src/contracts/bridge-generation.ts:30-31` `GENERATION`, `IS_PLACEHOLDER = bridge === null`; `SEND_GENERATION`, `HUB`, `FUEL` all `undefined` without a bridge | adapt (after sdk-1 a3 builds a `Network` only when a route exists) |
| Shell sections | `src/composables/useShell.ts:8, 26-36` (four static sections), `components/RailNav.vue:14-19` (static entries), `AppShell.vue:49-61` (headers) | adapt: one filter; no per-network hiding exists (searched `Section`, `ENTRIES`, `SECTION_PATHS`, `sectionAt`) |
| The gas lane | `SendWizard.vue` (`intent` :195; gas set-aside :683-692; fee line :698-716), `ChoiceCards.vue:54-55`, `lib/send-model.ts:13` (`"token" \| "token+gas" \| "gas"`), `useSend.ts:676-712` (router path, `runSend`), `lib/send-record.ts:59-86` (gas record) | reuse: the lane, record, journal, Activity and receipt already serve gas; only the bridge-bound guards change |
| Recipient | `SendWizard.vue:295` `recipient: () => bridge.selectedAccount` | reuse-as-is: a gas send already goes to the connected Aztec account |
| Fuel quote | `bridge-core/src/fuel-quote.ts:154` `lifiFuelProvider`, `:253` `manifestFuelProvider` (undefined without `bridge.l1`); `useFuelQuote.ts:54` passes no LI.FI client | sdk-1 a1 (`fuelRouteOf`) and a3 (the keyless client) replace it |
| Token catalog | `useTokenCatalog.ts:56-67` (AZTEC row), `:71, :171` (empty and no community list under `IS_PLACEHOLDER`) | adapt: a fuel-only network lists AZTEC and the community list |
| Source chains | `bridge-core/src/source-chains.ts:33-35` (Base, Arbitrum One, OP Mainnet deliver into chain 1, `rpcUrls: []`) | adapt: mainnet offers Ethereum only |
| Wallet capabilities | `lib/capabilities.ts:171` (hub optional), `:176-204` (FeeJuice and PrivateFPC always granted), `:307-311` (drip and sponsor scopes whenever drip addresses are passed); `useWalletConnection.ts:100-114` always passes them | adapt in a1 (follow the faucet) and a3 |
| Footer and addresses | `BridgeFooter.vue` (`bridgeGroups()` empty without a generation; mainnet "Real funds" line :79), `AddressesView.vue:28` | adapt: rows from the fuel route |
| Cross links | none in the app: `grep -rn "unleashed.systems\|testnet\.app\|app\.unleashed" apps/tools/src` finds only `network-targets.ts` and tests; the landing links testnet only (`apps/landing/src/content.ts:8`) | build new, from `TARGETS[…].host` |
| Drip catalog | `bridge-core/src/faucet-catalog.ts:12-23` (SIGNAL salt 4246, NOISE salt 4247, Dripper salt 1337, deployer zero) | reuse-as-is |
| Drip deploy | `apps/tools/scripts/deploy.ts` (`--network mainnet` exists :74; candidate-first :77-93; `--dry-run` :310-316; mainnet pays with `preexistingFeeJuicePayment` :341-348; `ensureAccountDeployed` :181-203) | adapt: the mainnet deployer's first transaction must claim its Fee Juice |
| Deployer funding | `bridge-core/src/fuel.ts:42` `planPublicFuelDeposit(recipient, amount, secret)` takes an injected secret; `fee-juice.ts:95` `publicFeeJuicePayment`; `fpc-dust-canary-mainnet.ts:125` (approve + `depositToAztecPublic` on chain 1) | reuse the planners (sdk-1 a2 moves them into the SDK) |
| Drip view | `views/DripView.vue:26-34, :83` (a dormant mainnet intro), `components/TokenCard.vue:200` (`DisclaimerTag`), `useDrip.ts:81, :100` (mainnet: the wallet's own fee method), `MintFeeAssetCard.vue` (needs `feeAssetHandler`, absent on mainnet) | adapt |
| Drip deploy runbook | `.claude/skills/bridge-generation/SKILL.md`: no faucet section and no mainnet procedure (grep `seed\|faucet\|drip\|SIGNAL\|NOISE\|mainnet`) | build new: one section |
| Mainnet faucet keyed template | only `apps/tools/testnet-faucet.env.example` | build new: `mainnet-faucet.env.example` |
| Browser variant without a token route | none: `grep -rn "mainnet\|bridge: null\|IS_PLACEHOLDER" apps/tools/tests/browser` finds nothing relevant; sdk-1 a3 adds a second local bundle under `/lifi/` | adapt sdk-1's mechanism: a third bundle |

## Verified facts (driver)

- **The canonical mainnet rollup is on 6.0.0; the repository pins the old one.** The mainnet Registry
  `0x35b22e09ee0390539439e24f06da43d83f90e298` (the address `lifi-fixtures-mainnet.ts:26` pins) answers
  `getCanonicalRollup() = 0xE37A2663…402f`, version 2070860440, `numberOfVersions() = 4`. That rollup's Fee Juice
  portal is `0x534361be…f3b3`, Inbox `0x603B06cE…B6aD`, fee asset `0xA27EC000…62D2`. The keyless nodes
  `https://aztec-mainnet.drpc.org` and `https://aztec.drpc.org` report `nodeVersion 6.0.0`, rollup 2070860440 and the
  same registry. The repository pins rollup 4248422647 (`chain-constants.ts:33`), whose portal is the manifest's
  `0xaf73dd51…691c` (`ROLLUP() = 0x91fF8bbD…8E34`, still producing checkpoints, `getRollup(4248422647)`), and the 5.0.1
  PrivateFPC `0x1a6d…1bc0` (`private-fpc-canonical-mainnet.json`). P3-04 holds; sdk-1's `OWNER-ASKS.md` §3 premise
  ("Mainnet runs Alpha 5.0.1") does not.
- **Keyless browser endpoints exist.** `aztec-mainnet.drpc.org` and `ethereum-rpc.publicnode.com` answer a CORS
  preflight from `https://app.unleashed.systems` (204, origin allowed, no redirect).
- **Drip on mainnet.** `bun scripts/deploy.ts --network mainnet --dry-run` prints the same three addresses as
  `src/contracts/deployments.json`, so one file serves both networks. None of the three instances exists on the mainnet
  node (`node_getContract` → null), and neither the Dripper class `0x000a2889…a5f3` nor the Token class
  `0x2ff09399…ea9f` is published there (`node_getContractClass` → null): the deploy publishes both classes.
- **The PrivateFPC needs no deploy.** The 6.0.0 instance `0x0516…6915` is unpublished on testnet and on mainnet;
  `check-fpc-version.ts:14-15` treats absence as green.
- **`deploy-seed-tokens.ts` is not the Drip deploy.** It deploys Sepolia `MintableERC20` seed tokens for a bridge
  generation (Sepolia only, :14, :42). The Drip catalog deploys through `apps/tools/scripts/deploy.ts`.
- **Mainnet Fee Juice has no transfer.** The deployer's Fee Juice can only arrive through an L1 portal deposit and a
  claim, so a fresh deployer's first transaction must be claim-and-deploy (`FeeJuicePaymentMethodWithClaim`).
- **The gas review reads `fjPerTx`.** `SendWizard.vue:710-715` prices a public gas claim from `FUEL.fjPerTx`;
  sdk-1's `fuelRoute.fuel` names only `slippageBps` and `minFuelFj` (sdk-1 plan, Phase 1.2).
- **terms-1 couples to this lane.** `apps/tools/src/lib/privacy-providers.test.ts` (terms-1 a1) requires the Privacy
  Policy's provider rows to equal every origin `MAINNET_TARGET` reaches; `legal-dist.ts` requires a mainnet dist to
  carry both document URLs and a testnet dist to carry no `MainnetPlaceholderView` chunk.
- **sdk-1 already re-pinned mainnet** on its branch (`45f73f6`: rollup version, wallet chain id, portal, PrivateFPC
  descriptor) and binds every send to its line (`bf8b0cf`, `aztecLineOf`); its `fuelRoute.fuel` has no `fjPerTx`.
- **Open work.** No open issue (`gh issue list --state open`). Closed known limits: #27 only, unrelated.

## Collision risks

- sdk-1 a3 and a4 rewrite `useSend.ts`, `useFuelQuote.ts`, `useGasShare.ts`, `useBridgeJournal.ts`, `deposit-flow.ts`,
  `fuelClaim.ts` and `contracts/bridge-generation.ts`; this lane edits their consumers only, after both merge.
- terms-1 owns `App.vue`'s mainnet branch, `MainnetPlaceholderView.vue`, `packages/legal` and the agree screen (a2).
- `IS_MAINNET` (per build) and `IS_PLACEHOLDER` (per manifest) mean different things; the shell must gate on the
  network's routes, so the local fuel-only bundle exercises the same code as mainnet.
