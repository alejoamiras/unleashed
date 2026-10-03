# Research: tools frontend (`apps/faucet`)

Snapshot: the base branch (post multi-account switcher, `useDeposit.ts` → `deposit-flow.ts` split). The task branch's base additionally splits `createAztecWalletSession.ts` into controllers — no bridge/fuel surface change.

## Shell + views

- `src/App.vue`: `type Tab = "faucet"|"bridge"|"fuel"` `:15`; default tab by target/host `:21-25`; three `<button class="tab">` + `ThemeToggle` `:38-70`; all views mounted via `v-show` `:80-82` (one shared wallet session); root singletons `ConnectionErrorStrip`, `AppToastRegion`, `WalletPickerModal`, `ChooseAccountModal`. Layout `max-width: 760px; padding: 80px 32px 96px; gap: 32px` `:97-105`. Tabs: `font-headline 600 15px`, active = tinted rectangle (`color-mix(txt 10%)`), not an underline.
- `BridgeView.vue` (hero + `.wallets` strip with `L1WalletPanel` + `BridgeWalletPanel` + `BridgeForm` + `BridgeJournal kind="bridge-token"` + `MintTestUsdc v-if=BRIDGE_TOKEN_MINTABLE` + `BridgeAddToken`); `FuelView.vue` mirrors (`FuelForm`, `MintFuelAsset v-if=FUEL_ASSET_HANDLER`, `BridgeJournal kind="fee-juice"`); `FaucetView.vue` = `TokenCard` grid over `FAUCET_TOKENS`.
- Form stage machine `BridgeForm.vue:68` `form → stepper → receipt` (`onRecord` `:215-220`, completion `:246-295`, fail-open `:305-325`, `onBackground` `:334-339`; account switch stands the form down `:92-101`). `FuelForm.vue:44,72-121` mirrors.
- Inputs today: direction flip `:51,:206,:391`; amount `type=number` default `"100"` `:419-430`; privacy = two cards PRIVATE/PUBLIC `:438-447`; "ARRIVE WITH GAS" toggle `:449-462` (only when `fuelAvailable = BRIDGE_FUEL !== undefined && direction === "l1-to-l2"` `:131`); fuel slice capped `MAX_FUEL_SLICE = 25 * 10^decimals` `:137`. **No token select, no recipient, no slippage UI.**
- Token choice: faucet tab = `src/constants/tokens.ts` (the first and second faucet tokens, pinned drip amounts); bridge/fuel = ONE build-time token (`BRIDGE_TOKEN_SYMBOL/DECIMALS`, `BRIDGE_TOKEN`, `L1_USDC` from `src/contracts/bridge-deployments.ts:27,112-123`).

## Components (all flat under `src/components/`; only `Flex` auto-resolves)

`AppToastRegion`, `BridgeAddToken` (Aztec `registerToken` + EIP-747), `BridgeFooter`, **`BridgeForm`** (~760), `BridgeJournal`, `BridgeJournalCard` (~745), **`BridgePhaseRail`** (324; `full`/`compact`; glyph + label + elapsed + eta + detail + ASCII bar + RETRY), **`BridgeReceipt`** (243; `ReceiptSnapshot` `:12-29`), `BridgeStepper` (163; takeover: headline, rail, BACKUP, RUN IN BACKGROUND), `BridgeWalletPanel`, `ConnectionErrorStrip`, `FeeJuiceNotice`, `Footer`, `FuelForm` (337), `L1WalletPanel` (72; Ethereum chip + wrong-chain button), `MintFuelAsset`, `MintTestUsdc`, `ThemeToggle`, **`TokenCard`** (350; faucet only), `VerificationModal`, `WalletPanel`, `WalletPickerModal` (only `<img>` in the app: wallet icons with a protocol allowlist `:137-147`), **`AccountSwitcher`** (428; hand-rolled sharp dropdown — rejects design `Popover` `:19-25`), `ChooseAccountModal`.

From `@unleashed/design` (`packages/design/src/index.ts:16-61`): `Button, Card, Toast, Flex, Icon, AddressDisplay, BalanceRow, DisclaimerTag, DripButton, EmojiGrid`. Resolver `scripts/design-resolver.ts:16 DESIGN_COMPONENTS = {"Flex"}`.

**Greenfield**: no `<select>`/combobox, no token icons (bare mono symbols), no token metadata layer beyond `src/lib/asset-label.ts` (`AssetKind = "bridge-token"|"fee-juice"`, `assetSymbol/assetDecimals`), no step-strip/wizard shell.

## Composables (`src/composables/`)

`createAztecWalletSession.ts` (discovery → picker → emoji → capabilities → choose-account → connected), `useWalletConnection.ts` (singleton; `switchActiveAccount` `:107`), `useBridgeWallet.ts` (re-export), **`useL1Wallet.ts`** (raw EIP-1193 `window.ethereum` `:15-18`; `publicClient` with a custom transport delegating every RPC to the injected provider `:29-38` because the CSP forbids page-origin RPC fetches `:20-27` → **L1 reads only work while a wallet is connected**; `walletClient` shallowRef rebuilt on `accountsChanged`; exports `:117-132`), `useDeposit.ts` (349) + **`deposit-flow.ts`** (1167; extracted protocol ops incl. `recoverDepositLeg` `:274`, `prepareFuelSlice` `:720`), `useWithdraw.ts` (307), `useFuel.ts` (311), `fuelClaim.ts`, `useL1FeeAsset.ts` (`FUEL_ASSET_DECIMALS = 18` `:12`), `useL1Usdc.ts` (`ERC20_ABI` `:10`, `MINT_AMOUNT` `:55`), **`useTokenBalance.ts`** (per-token L2 reader: `balance_of_public` simulate + `balance_of_private` utility, 15 s poll, caller-owned `dispose()`), **`useBridgeJournal.ts`** (~1100; the engine: records, runtime map, foreground/`activeFlowId`, lanes `runOnLane` `:190`, `Attention` `:53`, `BridgeStep` `:57`), `useBridgeBackup.ts` (sealed files; deterministic `personal_sign` + self-test `:47-84`), `useFaucetDrip.ts`, `useFaucetAddToken.ts` (`registerToken` via schema patch), `useSettledError.ts`, `useToast.ts`, `useTheme.ts`, `useOpsInFlight.ts`.

Quote call site: `BridgeForm.vue:149-174 refreshFuelQuote` (500 ms debounce `:179-184`; state `idle|loading|ok|error` `:57-59`; errors: `QuoteUnavailableError` message verbatim, else "Quote failed - bridging without fuel still works." `:167-173`; too-small `:162-165`; `fuelBlocksSubmit` requires `ok` `:147`). Route = `buildFuelRoute` over exactly `pools.tokenWeth` + `pools.ethFj` `:154-160` (`bridge-deployments.ts:78-84` hard-requires both).

## `src/lib/`

- `bridge-steps.ts`: `PhaseState` `:12`; `BridgePhase{key,label,state,detail?,progress?,eta?,landed?}` `:14-28`; keys `seal|approve|sign|deposit|sync|claim|confirm|exit|prove|finish` `:15`; deposit phases `:63-165` (labels `SEAL/APPROVE/AUTHORIZE/DEPOSIT(+ FUEL)/CROSSING/CLAIM(GAS)/CONFIRM`; ETAs deliberately overestimated), withdraw `:149-187`; the latch anchors on persisted facts; `TERMINAL_ATTENTIONS = {stale-deployment, receipt-mismatch}` `:35-42`.
- `claim-receipt.ts`: receipt → `success|dropped|reverted|proposed|pending` (`proposed` is display-only evidence).
- `asset-label.ts`, `fuel-claim-state.ts` (`decideFuelClaim`, `decidePrivateFuelClaim`, `FuelLadder`, `StandaloneFuelRecovery`, `RECEIPT_RECORD_MISMATCH_MSG`), `format.ts` (`formatBigInt`, `parseAmount` BigInt end-to-end, `trimAddress`, `trimTxHash`), `testids.ts` (~187 lines; `fa-` prefix; **e2e selects by testid only**).
- `network-targets.ts`: `FaucetTarget{key, l1ChainId, rollupVersion, walletChainId, manifestFile, host, nodeUrl, l1ExplorerBaseUrl, cspConnectSrc}`; testnet host `testnet.app.unleashed.systems`, mainnet `app.unleashed.systems`; `resolveFaucetTarget()` falls back to testnet `:81-84`. `chain-constants.ts`: plain numbers, no env override by design.

## Manifest consumption + build split

- `src/contracts/bridge-deployments.ts`: manifest injected as `VITE_BRIDGE_MANIFEST_JSON` `:24`, `parseCandidateManifest` at module init `:25`; flat scalar exports; L2 instances **rebuilt** from salt + args (`rebuildBridgeProxy/Token/BridgeInstance` `:127-157`, minter hardcoded to `BRIDGE_PROXY` as a cross-check).
- `useWalletConnection.ts:46-62` registers 7 instances with the wallet at connect (proxy, token, bridge, Dripper, the first and second faucet tokens, PrivateFPC).
- `vite.config.ts:141-187 makeFaucetConfig(target)`: `define`s target + inlined manifest + preview hosts; `buildMetaPlugin` (`dist/build.json`, the build meta tag, deletes the other target's manifest); `headersPlugin` writes `dist/_headers` with a per-target CSP `:99-132`. Runtime `assertBuildIntegrity()` before mount + `assertNodeChainMatches` (`src/main.ts:19-42`).
- Feature gates: `IS_MAINNET`, `BRIDGE_TOKEN_MINTABLE`, `FUEL_ASSET_HANDLER`, `BRIDGE_FUEL` presence (drops the whole "arrive with gas" UI silently). `viem/chains` Biome-banned outside `src/lib/network.ts`.

## Design system

`src/main.ts:3-4` imports `@unleashed/design/base.css` then `./app.css` (30 lines: shell globals + focus ring). Tokens in `packages/design/src/base.css` (dark `:70-121`, light `:123-190`): `--app-bg #0a0908`, the earlier `surface` `#141312`, `surface-low` `#1d1b1a`, `outline` `#4a463f`, `accent` `#f8f1e7` (light `#a8480c`) and `secondary` `#999187` tokens, `--txt-primary #f5f0e6`, semantic `--mint #18d2a5 --yellow #e6c525 --red #f03c3c`. Fonts: Space Grotesk (headline), InterVariable (body), JetBrains Mono (labels/data). **No `--radius` token; zero border-radius anywhere.** Reference CSS: `Card` (surface + hairline + 24px), `Button` (`primary` = accent bg, headline 700 uppercase; `cta` = full width, 0.2em tracking, 20px pad), `BalanceRow`, `AddressDisplay`, `Toast` (3px left rule), `BrutalistTitle`. Parity/drift tests guard tokens and utilities (`app.css.parity.test.ts`, `theme-vars.test.ts`, `packages/design/src/*.drift.test.ts`, `theme-contrast.test.ts`).

## Tests

Co-located `*.test.ts`, `vitest.config.ts` (jsdom, `setupFiles: ./src/test/setup.ts`, excludes `tests/e2e/**`), `bun --bun vitest run`. `useDeposit.characterization.test.ts` pins `deposit-flow.ts` verbatim (1918-line snapshot). E2E smoke `tests/e2e/{bridge,faucet,fuel}-smoke.test.ts` (jsdom, no browser): faucet uses a full mock wallet provider answering 7 RPCs; bridge/fuel `vi.mock` composables (`useL1Wallet`, `useBridgeWallet` incl. `accounts`+`hiddenAccountsCount`, `useL1Usdc`, `useTokenBalance`, `useDeposit`, `useWithdraw`) while the real journal engine runs on real jsdom `localStorage`.

## Chokepoints for the wizard (ranked)

1. Single-token by construction (`bridge-deployments.ts` scalars → `BridgeForm`, `useL1Usdc`, `useTokenBalance`, `asset-label.ts`, `bridge-steps.ts` labels, journal shape).
2. `.strict()` single-token manifest schema (`candidate-schema.ts`) → conductors, `promotion.ts`, `verify-deployments.ts`.
3. No metadata layer, no icons, no select primitive (follow `AccountSwitcher`'s hand-rolled sharp pattern).
4. Fixed 2-hop route + coarse quote errors → per-token candidate routes + first-class `no-route`.
5. Every new interactive element needs a `TESTIDS` entry first.
