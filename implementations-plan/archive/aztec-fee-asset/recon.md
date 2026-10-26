# Recon — aztec-fee-asset

Base: `main` at `6196c4b`. One Sonnet reuse sweep plus the driver's own reads and Sepolia reads.

## Reuse map

| Capability | Existing code | Verdict |
|---|---|---|
| One-for-one gas route for the fee asset | `packages/bridge-core/src/route-discovery.ts:99` returns `identity`; `SendWizard.vue` `NO_SWAP`, `ONE_TO_ONE`; `ChoiceCards.vue:61` "One for one." | reuse-as-is |
| Router call per intent | `packages/bridge-core/src/send-flow.ts:113-122`: public gas → `bridge()` into the FeeJuicePortal; private gas and token + gas → `bridgeWithFuel` with an empty path; token → `bridge()` into the factory portal | reuse-as-is |
| Router rules | `SwapBridgeRouter.sol:187-188` (empty path only for `FEE_ASSET`), `:256` (direct gas only public); forge `test_bridgeWithFuel_identity_*` (`SwapBridgeRouter.t.sol:203-243`), halmos canaries (`FormalRouter.t.sol:332-347`) | reuse-as-is |
| Token picker list | `useTokenCatalog.ts` `manifestCatalog()` (49-62) and `merge()` (86-103): manifest, then pasted, then the remote list, deduped by address; `addPasted` refuses a duplicate | adapt: prepend one synthesized row |
| Curated label | `useTokenSelection.ts:110` keeps a `source: "manifest"` row's own symbol and name; `:65` still reads live metadata when unregistered (decimals and words come from the chain); `metadataConflictOf` checks list rows only | reuse-as-is (pinned row uses `source: "manifest"`) |
| Tile mark | `token-mark.ts:37`: brand by exact key or manifest symbol, else a two-letter monogram | reuse-as-is ("AZ" monogram) |
| Wallet grants | `useWalletConnection.ts:78-130` grants `MANIFEST_TOKENS` at connect; `useTokenGrant` asks per selected token; gas-only skips it (`useSend.ts:564,584`) | reuse-as-is |
| L1 mint UI | `MintStrip.vue`: one-tap mints of manifest `permissionless-mint` tokens, receipt `status` check, `mintL1*` testids, `minted` event → balance refresh | adapt: add an $AZTEC button |
| Handler ABI | `FeeAssetHandlerAbi` from `@aztec-foundation/l1-artifacts` (302 entries, mostly errors); used by `scripts/fee-juice-canary-testnet.ts:23,69-85` | adapt: a 3-function app ABI pinned by test |
| Mint card on the Drip tab | none. `DripView.vue` renders L2 `TokenCard`s only | build new: the Drip tab has no Ethereum mint today |
| Handler in the sandbox | `scripts/sandbox/deploy.ts:56-60` reads node L1 addresses but not `feeAssetHandlerAddress`; the sandbox manifest (`sandbox/manifest.ts:44`) omits it; `mintFeeAsset` (`sandbox/l1.ts:45`) mints the TestERC20 directly | adapt: carry the handler into the sandbox manifest |

## Facts read live (Sepolia, public RPC)

- The fee asset `0x762c…3c18` answers `symbol() = "FEE"`, `name() = "FeeJuice"`, `decimals() = 18`.
- The handler `0x5602…f4bfc9` answers `FEE_ASSET() = 0x762c…3c18`, `mintAmount() = 1000e18`.
- The rc.3 FeeJuicePortal `0x6974…ce59` answers `UNDERLYING() = 0x762c…3c18`.
- `factory.portalOf(0x762c…3c18) = 0`: no user has bridged $AZTEC as a token on this generation yet.

## Collisions

- Do not add $AZTEC to the manifest `tokens[]`: those rows are pre-created portals that the deployment checks verify, and `MintStrip` keys on their `source`.
- Pasting the fee asset now hits "That token is already in the list." The browser cells that paste it (`deposit-gas-only.spec.ts` 18, 18b, 19) move to a tile click.
- `AppShell.vue:94-97` mounts Send and Drip together (`v-show`): the two mint surfaces need distinct testids, and one shared in-flight lock.
- Open PRs #7–#14 (lifi-routing) rewrite `SendWizard.vue`, `TokenStep.vue`, `ChoiceCards.vue`, `useTokenSelection.ts`, `bridge-generation.ts`. They keep the identity route (`useFuelQuote.ts:59`). They do not touch `useTokenCatalog.ts` or `DripView.vue`.
- Tests that mock `@/contracts/bridge-generation` (`useTokenCatalog.test.ts:17-29`, `DripView.test.ts:22-32`) must gain `FUEL_ASSET` / `FUEL_ASSET_HANDLER`.

## Absence trails

- Pinned fee asset: `FUEL_ASSET|feeAsset|isFeeAsset` over `apps/tools/src`. Only route and copy code.
- Old mint card: `MintFuelAsset|Mint \$AZTEC|Mint test` over `apps/tools`. `git log -S MintFuelAsset` reaches only the base commit.
- `FUEL_ASSET_HANDLER` callers: only `bridge-generation.ts:38` and test stubs.
- Open issues: `gh issue list --state all --search "AZTEC OR fee juice OR fee asset OR mint"` is empty.
