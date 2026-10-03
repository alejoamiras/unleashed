## Outcome

Archived. Seeds retired.

# Aztec Faucet — Consolidated Plan

Synthesized from three independent plans
authored against the same brief
([brief.md](brief.md)).

**Sources of each non-obvious decision** are cited inline as
`[mine]`, `[opus]`, `[codex]` (all three = consensus).

**v2 — post-audit.** Codex reviewed v1 and flagged 4 BLOCKERs + 7 SHOULDs. This
document is v1, preserved as the audit target. What v2 changed:

- **Phase order.** v2 re-ordered Phase F earlier so Phases C–E test against real
  on-chain contracts, not placeholders.
- **Phase F.** Uses `DEPLOYER_SECRET` + `AZTEC_NODE_URL` env (separate from the
  frontend's `VITE_AZTEC_NODE_URL`).
- **Phase C.** The connect button with all six states
  (idle/discovering/verifying/capability-approval/connected/error); the
  capability-approval inline UI is new in v2 — was collapsed into one state in v1.
- **Phase D.** The balance-reading composable polls every 15s
  via `wallet.executeUtility` — v2 corrected from the wrong API in v1.
- **Phase E.** v2 cut ActivityFeed — toast covers immediate feedback; the
  wallet's own history covers the durable record.
- **Phase G.** A mock wallet provider supporting all 7 RPCs the faucet uses — v2
  audit caught that v1's mock was missing `registerContract`.
- **Phase gate.** After each phase, `bun run --cwd packages/faucet typecheck && bun run --cwd packages/faucet test && bun run --cwd packages/faucet build`
  stays green. v2 fixed v1's shell-invalid `&& test &&` (would
  have run the shell builtin).
- **Tests.** ~55 unit/component cases + 5 smoke (down from v1's 95 — trimmed
  per audit).
- **§13.** One question remains — replaces v1's two-question §13 (which violated
  the brief): which exact alpha-testnet environment are we shipping against? Four
  values need to land in env before public hand-off: `AZTEC_NODE_URL`
  (and frontend `VITE_AZTEC_NODE_URL`) — the canonical RPC URL;
  `VITE_EXPLORER_BASE_URL` — the explorer behind the success-toast tx links;
  `VITE_CHAIN_ID` — wallet-sdk discovery matcher (so we don't ship a wildcard
  in prod); `VITE_CHAIN_VERSION` — matching protocol version. Bonus: is the
  Sponsored FPC known-good on the target environment right now? If it's down,
  every drip fails — we should know before we hand the URL out. Default if no
  answer: wildcard chainId, mainline alpha-testnet RPC. Works for dev; just less
  strict. v1 also asked about a custom hosting domain. Audit asked us to drop
  one — we kept the chainId/environment question because it directly affects
  whether drips work; domain only affects link copy and can be swapped via env
  later.
- **Bundle size.** If we ever open the faucet to the public and the cold-start
  latency becomes a complaint, we'd lazy-load the wasm behind the connect-button
  click.
- **Test token name confusion.** If Foundation feedback shows actual confusion,
  we can rename to `tUSDC` / `tETH`.

---

## 1. Summary

Build `packages/faucet/` as a static Vue 3 + Vite single-page app that
lets the Aztec Foundation team self-mint test USDC (decimals=6) and ETH
(decimals=18) on **alpha-testnet** through Wonderland's permissionless
`Dripper` contract from `@defi-wonderland/aztec-standards@4.2.0-aztecnr-rc.2`.

Visitors connect any Aztec wallet via `@aztec/wallet-sdk` (Nulo is the
only one in practice), and click one of four buttons: drip 1,000 USDC
to public, 1,000 USDC to private, 1 ETH to public, 1 ETH to private.
There is no backend, no rate limit, no custodial wallet, and no
network switcher.

The shipped product is **one screen, two cards, four buttons**. Three
success states, six error states, one toast. That's the entire surface.

---

## 2. Architecture

```text
┌────────────────────────────────────────────────────────────┐
│  Aztec alpha-testnet                                        │
│                                                             │
│    ┌──────────────────┐   ← salt 1337 (Wonderland default)  │
│    │  Dripper         │     permissionless;                 │
│    │  (no auth guard) │     drip_to_{public,private}(t, a)  │
│    └────────┬─────────┘                                     │
│             │ mint_to_{public,private}(msg_sender, amount)  │
│    ┌────────┴────────┐                                      │
│    │                 │                                      │
│  Token(USDC, d=6)  Token(ETH, d=18)                         │
│  minter=Dripper    minter=Dripper                           │
└───────────────────┬─────────────────────────────────────────┘
                    │
                    │ aztec RPC + SponsoredFPC fee (deterministic addr)
                    │
          ┌─────────▼──────────┐
          │  Aztec wallet      │   Discovery + emoji-verified
          │  (Nulo extension)  │   AES-GCM channel via wallet-sdk
          └─────────┬──────────┘
                    │ window.postMessage
                    │
   ┌────────────────▼─────────────────────────────────┐
   │  packages/faucet (static Vue 3 SPA)              │
   │                                                   │
   │  src/App.vue   ─ one screen, one column           │
   │    ├─ Hero                                        │
   │    ├─ WalletPanel                                 │
   │    │   ├─ ConnectButton                           │
   │    │   ├─ VerificationModal ← teleported          │
   │    │   └─ AddressDisplay + Disconnect             │
   │    ├─ AccountNotDeployedBanner (conditional)      │
   │    ├─ TokenCard × 2 (USDC + ETH)                  │
   │    │   ├─ DisclaimerTag                           │
   │    │   ├─ BalanceRow (public + private)           │
   │    │   └─ DripButton × 2 (public + private)       │
   │    ├─ ActivityFeed (last 5 drips)                 │
   │    ├─ AppToastRegion                              │
   │    └─ Footer                                      │
   └───────────────────────────────────────────────────┘
```

**State model — three composables, no Pinia.** The page has one user,
one wallet connection, one global in-flight action. Pinia is overkill.

| State | Lives in | Why |
|---|---|---|
| `status`, `wallet`, `provider`, `pendingConnection`, `selectedAccount` | `useWalletConnection` (module singleton) | Wallet must survive component re-mount. One concrete connection per tab. |
| `inflight: { token, target } \| null`, `last: Record<tokenSymbol, { txHash \| error }>`, `dripAndRefresh()` | `useFaucetDrip` (module singleton) | Global single-action gate. Wallet popups serialize anyway — letting two drips queue is confusing UX `[codex]`. |
| `publicBalance`, `privateBalance` per token | `useTokenBalance(tokenAddress)` (per-card instance) | Two cards poll independently every 15s. |
| Toast queue | `useToast` (module singleton) | One transient toast at a time. |
| Contract addresses | `src/contracts/deployments.json`, imported at module scope by `lib/contracts.ts` | Build-time constant. No reactivity needed. |

**Contract layout** (committed in `src/contracts/deployments.json`,
shape matches what `aztec-standards/scripts/deploy.ts` emits):

```json
{
  "tokens": [
    { "address": "0x…", "constructorArgs": { "name": "USDC", "symbol": "USDC", "decimals": 6,  "minter": "0x<dripper>" }, "salt": 4242, "deployer": "0x0…", "constructorArtifact": "constructor_with_minter" },
    { "address": "0x…", "constructorArgs": { "name": "ETH",  "symbol": "ETH",  "decimals": 18, "minter": "0x<dripper>" }, "salt": 4243, "deployer": "0x0…", "constructorArtifact": "constructor_with_minter" }
  ],
  "dripper": { "address": "0x…", "salt": 1337, "deployer": "0x0…", "constructorArtifact": "constructor" }
}
```

**Map by symbol, not array order** `[codex]` — `lib/contracts.ts` looks
up tokens by `constructorArgs.symbol === "USDC" | "ETH"`. The deploy
script writes an array; we don't rely on its order.

---

## 3. File-by-file layout

```text
packages/faucet/
├── README.md                              purpose, dev, deploy command, hosting
├── package.json                           "@unleashed/tools", exact pins matching Aztec line
├── tsconfig.json                          extends root; vue type plugin; @/* alias
├── biome.json                             extends root; faucet-specific layer rules (no L0-L6 needed; one screen)
├── vite.config.ts                         vue + nodePolyfills + COOP/COEP dev headers; dedupes noir-acvm_js/noirc_abi
├── vitest.config.ts                       vue-aware vitest; jsdom; test/setup.ts
├── index.html                             entry + node-globals shim (Buffer, process)
├── public/
│   ├── _headers                           Cloudflare Pages: COOP, COEP, CSP, cache
│   ├── favicon.svg                        mark
│   └── fonts/
│       ├── SpaceGrotesk-latin.woff2
│       ├── InterVariable.woff2
│       └── JetBrainsMono-latin.woff2
├── scripts/
│   ├── deploy-config.ts                   faucet-only token list (USDC d=6, ETH d=18) + network config
│   └── deploy.ts                          self-contained deployer (~150 lines vendored from aztec-standards)
├── src/
│   ├── main.ts                            createApp, mount, vendored CSS imports
│   ├── App.vue                            single page: Hero + WalletPanel + AccountNotDeployedBanner + TokenCards + ActivityFeed + Toast + Footer
│   ├── env.d.ts                           Vite typings for VITE_AZTEC_NODE_URL, VITE_EXPLORER_BASE_URL, VITE_CHAIN_ID, VITE_CHAIN_VERSION, VITE_WALLET_INSTALL_URL
│   ├── test/
│   │   └── setup.ts                       jsdom shims (process, global, Buffer); matchMedia stub
│   ├── design/
│   │   ├── base.css                       vendored CSS vars + reset + @font-face
│   │   └── tokens.ts                      vendored typed reflection of CSS var names
│   ├── constants/
│   │   └── tokens.ts                      `{ symbol, decimals, displayAmount, onchainAmount: bigint }` per faucet token
│   ├── contracts/
│   │   ├── deployments.json               committed deploy output (Dripper + USDC + ETH on alpha-testnet)
│   │   ├── deployments.ts                 parses + validates; reconstructs ContractInstance for each
│   │   ├── deployments.test.ts            invariants: minter==dripper, decimals correct, addresses parse
│   │   └── sponsored-fpc.ts               computes deterministic SponsoredFPC address from SPONSORED_FPC_SALT
│   ├── lib/
│   │   ├── chain-info.ts                  reads URL ?chainId/?version + VITE_CHAIN_* + falls back to Fr.ZERO/Fr.ZERO
│   │   ├── capabilities.ts                builds the exact AppCapabilities manifest
│   │   ├── capabilities.test.ts           proves metadata + exact scopes + no extra capability types
│   │   ├── wallet.ts                      pure helpers: extractGrantedAccounts, registerContractsInOrder
│   │   ├── errors.ts                      normalizes wallet/discovery/tx errors → UI categories
│   │   ├── errors.test.ts                 covers reject, network, fee, init, revert cases
│   │   ├── format.ts                      formatBigInt(value, decimals, places), trimAddress, trimTxHash
│   │   ├── format.test.ts                 5 cases for amount formatting + address shortening
│   │   ├── testids.ts                     CENTRAL data-testid catalog ("fa-…" prefix)
│   │   ├── explorer.ts                    explorerTxUrl(hash), explorerAddressUrl(addr) using VITE_EXPLORER_BASE_URL
│   │   └── emoji.ts                       re-exports hashToEmoji from @aztec/wallet-sdk/crypto + chunk-to-3x3 helper
│   ├── composables/
│   │   ├── useWalletConnection.ts         discovery → secureChannel → confirm → requestCapabilities → register contracts
│   │   ├── useWalletConnection.test.ts    ≥10 cases (CLAUDE.md composable rule)
│   │   ├── useFaucetDrip.ts               builds dripper exec; attaches SponsoredFPC feePayer; sendTx; receipt wait
│   │   ├── useFaucetDrip.test.ts          ≥10 cases
│   │   ├── useTokenBalance.ts             polls balance_of_public/private every 15s; manual refresh; dispose()
│   │   ├── useTokenBalance.test.ts        ≥10 cases
│   │   ├── useToast.ts                    queue + auto-dismiss
│   │   └── useToast.test.ts               5 cases
│   └── components/
│       ├── ui/                            L1/L2 primitives (≥5 cases each per CLAUDE.md)
│       │   ├── AppButton.vue              variants: primary | outline | ghost
│       │   ├── AppButton.test.ts
│       │   ├── Spinner.vue                CSS-only, currentColor
│       │   ├── Spinner.test.ts
│       │   ├── Tag.vue                    "Test token · no real value" chip
│       │   ├── Tag.test.ts
│       │   ├── Card.vue                   outlined surface, 1px brutalist border
│       │   ├── Card.test.ts
│       │   ├── Toast.vue                  single toast item
│       │   └── Toast.test.ts
│       ├── composite/                     L3 composites (≥10 cases each per CLAUDE.md)
│       │   ├── EmojiGrid.vue              3×3 grid fed by hashToEmoji output
│       │   ├── EmojiGrid.test.ts
│       │   ├── AddressDisplay.vue         "0x12a8…3f9c" + click-to-copy
│       │   ├── AddressDisplay.test.ts
│       │   ├── BalanceRow.vue             public + private labels + numbers
│       │   ├── BalanceRow.test.ts
│       │   ├── DisclaimerTag.vue          "Test token · no real value"
│       │   ├── DisclaimerTag.test.ts
│       │   ├── DripButton.vue             single drip action with idle/dripping/success/error
│       │   └── DripButton.test.ts
│       ├── VerificationModal.vue          wallet verification overlay with EmojiGrid + match/cancel
│       ├── VerificationModal.test.ts      ≥5 cases
│       ├── WalletPanel.vue                idle / no-wallet / discovering / verifying / connected / error
│       ├── WalletPanel.test.ts            ≥8 cases (state-rich)
│       ├── AccountNotDeployedBanner.vue   inline banner above token cards when account contract missing
│       ├── AccountNotDeployedBanner.test.ts
│       ├── TokenCard.vue                  USDC/ETH card: symbol, disclaimer, balance row, drip buttons, status row
│       ├── TokenCard.test.ts              ≥10 cases (L3 composite)
│       ├── ActivityFeed.vue               last 5 drips: amount → target · short tx hash · status · explorer link
│       ├── ActivityFeed.test.ts           ≥5 cases
│       ├── AppToastRegion.vue             fixed-position toast renderer driven by useToast
│       └── Footer.vue                     network info + contract links + Nulo/Wonderland links + disclaimer
└── tests/
    └── e2e/
        ├── README.md                       how smoke runs (no Aztec network required)
        ├── faucet-smoke.test.ts            5 cases against a mock wallet provider
        └── helpers/
            ├── mockWalletProvider.ts       fake provider — postMessage discovery + canned RPC replies
            └── pageHelpers.ts              puppeteer drivers
```

**Total** ~45 source files. About half are colocated `.test.ts` stubs.

**Testid catalog (all `fa-` prefix)** `[opus, codex]` — defined in
`src/lib/testids.ts` so renames stay safe:

- `fa-status` (carries `data-status="idle|discovering|verifying|connected|error"`)
- `fa-btn-connect`, `fa-btn-disconnect`, and one for the wallet-install CTA
- `fa-account` (selected account chip)
- `fa-banner-account-not-deployed`
- `fa-verification-modal`, `fa-emoji-grid`, `fa-emoji-cell-{0..8}`, `fa-btn-verify-confirm`, `fa-btn-verify-cancel`
- `fa-token-card` (with `data-symbol="USDC|ETH"`)
- `fa-balance-public`, `fa-balance-private`
- `fa-btn-drip-public`, `fa-btn-drip-private`
- `fa-drip-status` (carries `data-drip-status="idle|dripping|ok|error"`)
- `fa-activity-feed`, `fa-activity-row` (with `data-tx-hash`)
- `fa-toast` (with `data-kind="ok|error|info"`)

E2E selectors stay strict per CLAUDE.md: testids only, never text/aria/role/class.

---

## 4. Phase plan

Seven phases. Each ends with a green local gate before the next starts.
Validation = `bun run --cwd packages/faucet typecheck && test && build`
unless noted.

### Phase A — Scaffold + brand foundation (½ day)

**Files**: `package.json`, `tsconfig.json`, `vite.config.ts`,
`vitest.config.ts`, `biome.json`, `index.html`, `src/main.ts`,
`src/App.vue` (placeholder), `src/env.d.ts`, `src/test/setup.ts`,
`src/design/{base.css,tokens.ts}`, `public/fonts/*`, `public/favicon.svg`,
`public/_headers`, plus L1/L2 primitives (`ui/{AppButton,Spinner,Tag,Card,Toast}.vue`
+ tests). Root `package.json`: add `dev:faucet`, `build:faucet`,
`test:faucet`.

**Vite config** copies the Nulo wallet's proven pattern: `vite-plugin-node-polyfills`,
COOP/COEP dev headers (`server.headers`), dedupe of
`@aztec/noir-noirc_abi` + `@aztec/noir-acvm_js`. Port `5176`,
`strictPort: true` `[codex]`.

**Validation**: `bun install && bun run --cwd packages/faucet typecheck && test && build`. Placeholder renders. 25+ test cases green.

**Risk**: bb.js wasm + COOP/COEP fragility surfaces even at scaffold
time. **Mitigation**: mirror the proven pattern
exactly. Don't invent a lighter shim.

### Phase B — Contracts plumbing (½ day)

**Files**: `src/constants/tokens.ts`, `src/contracts/sponsored-fpc.ts`,
`src/contracts/deployments.json` (with placeholder addresses so
typecheck passes; real ones land in Phase F),
`src/contracts/deployments.ts`, `src/contracts/deployments.test.ts`.

**Critical** `[codex, opus]`: `deployments.ts` does NOT pass the JSON
straight to `wallet.registerContract`. It rebuilds each
`ContractInstance` via `getContractInstanceFromInstantiationParams(artifact, {constructorArgs, salt, publicKeys: PublicKeys.default(), deployer: AztecAddress.ZERO, constructorArtifact})`.
The raw JSON is *deploy metadata*, not a registerable instance.

**Token amounts** in `src/constants/tokens.ts`:

```ts
export const FAUCET_TOKENS = [
  { symbol: "USDC", decimals: 6,  displayAmount: "1,000", onchainAmount: 1_000_000_000n },
  { symbol: "ETH",  decimals: 18, displayAmount: "1",     onchainAmount: 1_000_000_000_000_000_000n },
] as const
```

Both `onchainAmount`s fit in u64 (max 1.84e19).

**Validation**: typecheck + test. `deployments.test.ts` asserts:
- Each address parses as `AztecAddress`
- `dripper.address !== AztecAddress.ZERO`
- Each token's `constructorArgs.minter === dripper.address`
- Each token's `constructorArgs.decimals` matches `FAUCET_TOKENS`

**Risk**: artifact import path. Use the proven path the Nulo wallet
uses `[codex]`: `@defi-wonderland/aztec-standards/dist/src/artifacts/Token.js`
and `…/Dripper.js`. Confirm in `vite.config.ts` aliases at scaffold time.

### Phase C — Wallet connect flow (1 day)

**Files**: `lib/{chain-info,capabilities,wallet,emoji,errors,testids}.ts`
+ tests, `composables/{useToast,useWalletConnection}.ts` + tests,
`components/{ui/Toast,AppToastRegion}.vue`,
`components/composite/{EmojiGrid,AddressDisplay}.vue` + tests,
`components/VerificationModal.vue` + test,
`components/WalletPanel.vue` + test,
`components/AccountNotDeployedBanner.vue` + test,
`src/App.vue` (real layout starts).

**`chain-info.ts` precedence** `[codex]`:
1. URL `?chainId=…&version=…`
2. `VITE_CHAIN_ID` / `VITE_CHAIN_VERSION` env
3. `Fr.ZERO` / `Fr.ZERO` permissive (matches any wallet)

**Emoji source**: `import { hashToEmoji } from "@aztec/wallet-sdk/crypto"`
(public export per the wallet-sdk skill doc; same function the Nulo
wallet uses → output matches by construction).

**Account-not-deployed banner**: on connect, do a one-shot
`node.getContract(selectedAccount)`. If null, render the banner:
`Your wallet account isn't on-chain yet. Send any transaction from your
wallet first to initialize it — then come back here.` Banner stays
visible until next reconnect or successful drip (which would itself
fail without an account, surfacing the wallet's own error).

**Validation**: typecheck + test + build. Manual: dev server + Nulo
wallet → end-to-end discovery + emoji + confirm.

**Risk**: emoji palette divergence between dApp and wallet
([opus flagged this as biggest risk]) — non-issue, both sides import
the same `@aztec/wallet-sdk/crypto` helper.

### Phase D — Token reads (½ day)

**Files**: `lib/{format,explorer}.ts` + tests,
`composables/useTokenBalance.ts` + test,
`components/composite/{BalanceRow,DisclaimerTag}.vue` + tests,
`components/TokenCard.vue` skeleton (symbol + balance row, no drip
buttons yet), `App.vue` renders 2 TokenCards when connected.

**`useTokenBalance`**: uses `wallet.simulateUtility(token.methods.balance_of_public(addr).request(), { from: addr })`. Utility calls
don't need fees and don't pop wallet UI. Polls every 15s via `setInterval`;
disposed in `onBeforeUnmount` via the composable's `dispose()`.

**Validation**: typecheck + test + build. Manual: with placeholder
deployments.json the UI surfaces "—" cleanly on missing contracts.

### Phase E — Drip flow (1 day)

**Files**: `composables/useFaucetDrip.ts` + test,
`components/composite/DripButton.vue` + test, full `TokenCard.vue` + test,
`components/ActivityFeed.vue` + test, `App.vue` wiring.

**`useFaucetDrip` shape** — one composable, one global in-flight state
`[codex]`:

```ts
const inflight = ref<{ tokenSymbol: string; target: "public" | "private" } | null>(null)
const last = reactive<Record<string, { kind: "txHash" | "error"; value: string } | null>>({})
const activity = ref<Array<{ tokenSymbol: string; target: string; txHash: string; status: "submitting"|"ok"|"failed" }>>([])

async function drip(token, target) {
  if (inflight.value) return  // global gate; all 4 buttons disabled in UI
  inflight.value = { tokenSymbol: token.symbol, target }

  const dripper = await DripperContract.at(DRIPPER, wallet)
  const interaction = target === "public"
    ? dripper.methods.drip_to_public(token.address, token.onchainAmount)
    : dripper.methods.drip_to_private(token.address, token.onchainAmount)

  const exec = await interaction.request()
  // Explicit feePayer keeps the faucet wallet-agnostic — works with any
  // wallet that speaks wallet-sdk, not just Nulo.
  const tx = await wallet.sendTx(
    { ...exec, feePayer: SPONSORED_FPC_ADDRESS },
    { from: selectedAccount },
  )
  // Default wallet-sdk sendTx waits for node.getTxReceipt — use that
  // boundary as success, not optimistic "submitted".
  // ...store txHash in last + activity; trigger token's balance.refresh()
}
```

**Why explicit `feePayer`** `[codex]`: Opus's plan suggested leaving
`feePayer` unset and letting the Nulo wallet pick a fee path. That's
specific to that wallet. We settled on "any wallet via SDK" — explicit
`SPONSORED_FPC_ADDRESS` works for every wallet and fails bluntly if a
wallet can't use it. The faucet doesn't depend on that wallet's behavior.

**Why one global in-flight** `[codex]`: wallet popups serialize anyway —
allowing four parallel button clicks just queues confusing popups. All
four DripButtons disable while one is in flight; the active one shows
the spinner.

**Validation**: typecheck + test + build. Manual end-to-end requires
Phase F.

### Phase F — Contract deployment (½ day)

**Files**: `scripts/deploy-config.ts`, `scripts/deploy.ts` (~150 lines
vendored from `aztec-standards/scripts/deploy.ts` with our token list),
real `src/contracts/deployments.json` (committed).

**Why vendor instead of importing** `[mine, opus, codex consensus]`:
- aztec-standards' `scripts/` directory is NOT in the published npm tarball
  (only `dist/artifacts/*` is).
- We want a different token list (USDC + ETH, not their WETH + DAI + USDC).
- Vendoring keeps the deployer self-contained and operable from a clean
  checkout.

**Maintainer command**:

```bash
cd packages/faucet
DEPLOYER_SECRET="<32+ char string>" bun run deploy:testnet
```

The script:
1. `createAztecNodeClient(VITE_AZTEC_NODE_URL ?? alpha-testnet default)`
2. `EmbeddedWallet.create(nodeUrl, { pxeConfig: { proverEnabled: true, dataDirectory: ".faucet-deploy-store/" } })`
3. Schnorr deployer derived from `poseidon2Hash([Fr.fromBufferReduce(Buffer.from(DEPLOYER_SECRET))])`
4. Ensure deployer account contract deployed via sponsored FPC
5. Compute deterministic addresses for Dripper (salt 1337), USDC (salt 4242), ETH (salt 4243)
6. For each, `node.getContract(addr)` first; if absent, `Contract.deploy(...)` via sponsored FPC
7. Write `src/contracts/deployments.json` (overwriting in place; commit)

**Idempotent**: re-running is a no-op if everything exists at the
deterministic addresses. Logs `[EXISTING]` for each.

**Salt 1337 for Dripper** matches Wonderland's default → if their Dripper
is already at this salt on alpha-testnet, ours collides to the same
address (by construction). That's fine — we share their Dripper. Tokens
get our own salts (4242, 4243) to avoid colliding with their WETH/DAI/USDC.

**Optional flags**: `--dry-run` (compute + print without sending),
`--salt <n>` (restart with a fresh salt if a borked deploy needs eviction).

**Validation**: smoke end-to-end. Dev server + Nulo → all four drips
work; tx hashes appear; balances refresh; explorer links open.

### Phase G — Smoke e2e + polish + README (½ day)

**Files**: `tests/e2e/helpers/{mockWalletProvider,pageHelpers}.ts`,
`tests/e2e/faucet-smoke.test.ts`, `README.md`, Footer copy finalized,
small Lighthouse spot-check.

**Smoke e2e (5 cases)**: against a mock wallet provider that intercepts
`aztec-wallet-discovery` postMessage and responds with canned WalletInfo
+ a MessagePort. Implements just the 5 RPCs we use: discovery handshake,
`establishSecureChannel`, `confirm`, `requestCapabilities`,
`simulateUtility` (returns BigInt 0n), `sendTx` (returns deterministic
fake txHash).

1. Empty state — no wallet detected
2. Discover → emoji modal → confirm → connected
3. Renders 2 TokenCards with balances rendered as "0.00"
4. Click drip USDC public → button loading → success toast with explorer link
5. Disconnect → resets to empty

**Validation**: `bun run --cwd packages/faucet test:e2e` green.

**Total**: ~4 working days for a solo author, each phase ending green.

---

## 5. Wallet-SDK integration details

**Discovery** flow:

```ts
const manager = WalletManager.configure({ extensions: { enabled: true } })
const discovery = manager.getAvailableWallets({
  chainInfo: readChainInfo(),
  appId: "faucet",
  timeout: 60_000,
})
for await (const provider of discovery.wallets) {
  firstProvider = provider
  break
}
```

`Fr.ZERO/Fr.ZERO` is the permissive matcher. Production we pin via
`VITE_CHAIN_ID` + `VITE_CHAIN_VERSION` once the alpha-testnet values are
confirmed (see §13).

**Emoji verify modal**: `pending.verificationHash` →
`hashToEmoji(hash)` → split into 9 emoji string → render 3×3 grid in
`VerificationModal`. Match → `await pending.confirm()` returns the
`Wallet`. Cancel → `pending.cancel()` and SDK rejects.

The emoji surface is the **only** emoji in the entire faucet. It's
protocol security material, not UI decoration — the no-emoji rule from
CLAUDE.md doesn't apply (it's a brand rule, not a security rule).

**Capability manifest** — declared once, scoped tight `[codex]`:

```ts
{
  version: "1.0",
  metadata: {
    name: "faucet",
    version: "0.1.0",
    description: "Test USDC + ETH on Aztec alpha-testnet",
    url: window.location.origin,
  },
  capabilities: [
    { type: "accounts", canGet: true, canCreateAuthWit: false },
    { type: "contracts", contracts: [DRIPPER, USDC, ETH], canRegister: true, canGetMetadata: true },
    { type: "simulation", utilities: { scope: [
      { contract: USDC, function: "balance_of_private" },
      { contract: USDC, function: "balance_of_public" },
      { contract: ETH,  function: "balance_of_private" },
      { contract: ETH,  function: "balance_of_public" },
    ]}},
    { type: "transaction", scope: [
      { contract: DRIPPER, function: "drip_to_public" },
      { contract: DRIPPER, function: "drip_to_private" },
    ]},
  ],
}
```

No wildcard scopes. `canCreateAuthWit: false` (no authwits needed —
Dripper has no permission guards).

**Granted accounts** come from `result.granted` (filter for `type: "accounts"`),
not from a follow-up `wallet.getAccounts()`. Use the first account.

**Contract registration** — strict order, after capability grant:

```ts
const instances = rebuildInstancesFromDeployments(deploymentsJson)
await wallet.registerContract(instances.dripper, DripperContractArtifact)
await wallet.registerContract(instances.usdc,    TokenContractArtifact)
await wallet.registerContract(instances.eth,     TokenContractArtifact)
await wallet.registerContract(sponsoredFpcInstance, SponsoredFPCContract.artifact)  // for feePayer
```

**Fee payment**: `sponsored-fpc.ts` computes the deterministic address
from `SPONSORED_FPC_SALT` (`@aztec/constants`) + `SponsoredFPCContract.artifact`.
Faucet attaches `feePayer: SPONSORED_FPC_ADDRESS` to every drip exec.

**Wait boundary** `[codex]`: don't pass `wait: "NO_WAIT"`. The default
SDK `sendTx` waits for `node.getTxReceipt(txHash)` — that's the right
success boundary. UI shows success only after that resolves.

**Disconnect**: subscribe to `provider.onDisconnect()` → reset state.
Manual disconnect calls `provider.disconnect()` (best-effort).
Browser refresh forgets everything. No auto-reconnect by design.

---

## 6. UX & copy

Tone: brutalist, confident, no marketing fluff. Match the visual register
established by the Nulo wallet (dark surfaces, cream accent, mono details).

### Layout

Single column, max-width 720px, centered. Five stacked bands: hero,
wallet panel, optional banner, two TokenCards side-by-side (collapses on
narrow), activity feed, footer.

### Copy (final)

**Hero**:
- H1: `DRIP TEST ASSETS`  *(brutalist, declarative — chosen from Codex's draft)*
- Sub: `Alpha-testnet only. Connect an Aztec wallet and mint fixed USDC or ETH into a public or private balance. Internal faucet. No real value.`

**Empty (no wallet detected)** — fired after 60s discovery timeout:
- Title: `No Aztec wallet detected on this browser.`
- Body: `This faucet works with any wallet that speaks the Aztec Wallet SDK. Nulo is the fastest way to start — it's an extension, takes 30 seconds.`
- CTA: `Install Nulo` (links to `VITE_WALLET_INSTALL_URL`, defaults to Chrome Web Store listing)

**Connect button states**:
- idle: `Connect wallet`
- discovering: `Searching for wallet…`
- verifying: `Verify in wallet` (paired with modal)
- connected: hidden (replaced by AddressDisplay + `Disconnect` link)
- error: `Retry connection` (inline subtext: `Connection failed.`)

**Verification modal**:
- Title: `VERIFY THE GRID`
- Body: `Match this grid with the wallet window. If it differs, stop.`
- Secondary: `This check is for the secure channel. It is not decorative.`
- Buttons: `[ Cancel ]` `[ They match ]`

**Account-not-deployed banner**:
> `Your wallet account isn't on-chain yet. Send any transaction from your wallet first to initialize it — then come back here.`

**Connected header**:
- `Connected · 0x12a8…3f9c · alpha-testnet`  [copy] [Disconnect]

**TokenCard chrome**:
- Header: `USDC` (mono symbol, 24pt) and below: `Fixed drip: 1,000 USDC`
- Tag bottom-left: `Test token · no real value`

**TokenCard balance row**:
```
balance · public   0.00
balance · private  0.00
```

**TokenCard buttons** (idle):
- `Drip 1,000 USDC to public`
- `Drip 1,000 USDC to private`
- `Drip 1 ETH to public`
- `Drip 1 ETH to private`

**TokenCard states**:
- idle helper: *(empty)*
- dripping helper: `Submitting in wallet…` (with note: private drips take 30–90s) `[opus]`
- success helper: `Submitted to alpha-testnet.`
- error helper: `Last request failed.`  (with `Retry` link)

**Drip success toast**:
- `Dripped 1,000 USDC to public · view tx`  (tx link)
- `Dripped 1,000 USDC to private · view tx`
- `Dripped 1 ETH to public · view tx`
- `Dripped 1 ETH to private · view tx`

**Error toasts** (categorized in `lib/errors.ts`):
- User rejected: `Rejected in wallet.`
- No wallet: `No wallet found. Install Nulo and reload.`
- Network down: `Alpha-testnet is not responding. Try again.`
- Tx reverted: `Drip transaction reverted — view tx.`
- No fee asset / sponsored FPC unavailable: `No sponsored fee route available. Wait or report.`
- Account uninitialized: `Selected account isn't deployed on alpha-testnet. Send any tx from your wallet first.`
- Contract not registered: `Couldn't register the faucet contracts with your wallet. Reconnect.`

**ActivityFeed**:
- Empty: `No drips yet. Connect and click a button.`
- Row format: `1,000 USDC → public  ·  0x4e2f…ab12  ·  confirmed  ·  view`

**Footer**:
- `Contracts: USDC · ETH · Dripper`  (each → explorer)
- `Alpha-testnet only · Permissionless dripper · Fixed amounts · No rate limit`
- `Nulo Wallet · GitHub · Wonderland aztec-standards`

No emojis anywhere except the verification grid.

### Visual register
- BG `#0a0908`, surfaces `#141312`, text `#f5f0e6`, accent `#f8f1e7`.
- Headline: Space Grotesk 700, tracking -0.02em.
- Body: Inter 400/500.
- Mono: JetBrains Mono for addresses, hashes, the verification grid, amounts.
- Borders: solid 1px `#4a463f` outlined containers. No shadows, no gradients.
- Buttons: 2px outline for ghost; solid accent with dark text for primary; never both.
- Animations: 150ms opacity on hover, one CSS-only spinner. That's it.

---

## 7. Tests

CLAUDE.md guidance: enough tests to prove what we want works and that
failures are caught. We don't over-create.

### Unit / composable (colocated `*.test.ts`)
- **`useWalletConnection.test.ts` — ≥10**: idle→discovering→verifying→connected; cancel from verifying; no-provider timeout; multi-account granted; granted.accounts populates state; multiple `connect()` dedupe; disconnect; reconnect; provider.onDisconnect handler; capability rejection.
- **`useFaucetDrip.test.ts` — ≥10**: USDC public uses `1_000_000_000n`; USDC private same; ETH uses `1e18n`; sets `from`; injects `feePayer = SPONSORED_FPC_ADDRESS`; receipt success transitions state; rejection→rejected toast; revert→error state; concurrent drip blocked by global in-flight; state resets after completion.
- **`useTokenBalance.test.ts` — ≥10**: initial fetch (public + private); polls every 15s; stops on dispose; refresh() invalidates timer; contract-not-found → safe zero; RPC error surfaces; returns BigInt unmodified; multiple instances independent; switching wallet resets; formatBigInt path coverage.
- **`useToast.test.ts` — 5**: add; dismiss; auto-dismiss; queue order; max queue size.

### Library
- **`deployments.test.ts` — 5** `[opus, codex]`: parses JSON; every address parses as `AztecAddress`; `dripper.address !== AztecAddress.ZERO`; every `token.constructorArgs.minter === dripper.address`; decimals match `FAUCET_TOKENS`.
- **`capabilities.test.ts` — 5** `[codex]`: metadata fields; accounts capability shape; contracts scope exact; transaction scope exact; no extra capability types.
- **`errors.test.ts` — 5** `[codex]`: user reject (`code === 4001`); no-wallet; network failure; revert message; account-uninitialized; sponsored-fee failure.
- **`format.test.ts` — 5**: zero; integer; decimal-place trim; 1e9; 1n with decimals=18.

### Component (colocated)
Coverage minimums from CLAUDE.md.

| Component | Cases |
|---|---|
| `AppButton` | 5 (variants, disabled, loading, click) |
| `Spinner` | 5 |
| `Tag` | 5 |
| `Card` | 5 |
| `Toast` | 5 |
| `DisclaimerTag` | 5 |
| `EmojiGrid` | 10 (L3) |
| `AddressDisplay` | 10 (L3) |
| `BalanceRow` | 10 (L3) |
| `DripButton` | 10 (L3) |
| `VerificationModal` | 5 |
| `WalletPanel` | 8 (state-rich) |
| `AccountNotDeployedBanner` | 5 |
| `TokenCard` | 10 (composite) |
| `ActivityFeed` | 5 |
| `Footer` | 5 |

**Total**: ~95 unit/component cases + 5 smoke. Sub-30s `bun run test`.

### Smoke e2e (5 cases, single spec)
Mock wallet provider. No Aztec network. See §4 Phase G.

### Network e2e — DEFERRED
The faucet runs against alpha-testnet. Network e2e in CI would (a)
require a funded deployer key, (b) consume drips on every CI run,
(c) flake whenever the testnet stutters. ROI is negative for a
1-screen app. Manual smoke before merge:

1. Connect Nulo on alpha-testnet
2. Drip USDC to public
3. Drip USDC to private
4. Drip ETH to public
5. Drip ETH to private
6. Reject one drip in the wallet; verify error path
7. Disconnect and reconnect

---

## 8. Deploy story

Single command, run once by the maintainer:

```bash
cd packages/faucet
export DEPLOYER_SECRET="<32+ char string>"
bun run deploy:testnet
```

Optional:
```bash
bun run deploy:testnet:dry    # compute addresses without sending
bun run deploy:testnet -- --salt 1338    # restart with fresh salt
```

`scripts/deploy.ts` is self-contained (~150 lines vendored from
`aztec-standards/scripts/deploy.ts`). It does:

1. `createAztecNodeClient(VITE_AZTEC_NODE_URL || alpha-testnet default)`
2. `EmbeddedWallet.create(...)` with `proverEnabled: true`
3. Schnorr deployer from `poseidon2Hash([Fr.fromBufferReduce(Buffer.from(DEPLOYER_SECRET))])`
4. Register SponsoredFPC; build `SponsoredFeePaymentMethod` for deploy fees
5. Ensure deployer account is deployed
6. Compute addresses for Dripper (salt 1337), USDC (4242), ETH (4243)
7. For each: check `node.getContract(addr)`; if absent, deploy
8. Write `packages/faucet/src/contracts/deployments.json`

**Idempotent**: re-run = no-op if everything exists. Partial deploys
resume cleanly.

**Frontend pickup**: `src/contracts/deployments.ts` imports the JSON at
module scope:

```ts
import deploymentsJson from "./deployments.json"
import { AztecAddress } from "@aztec/aztec.js/addresses"
import { TokenContractArtifact } from "@defi-wonderland/aztec-standards/dist/src/artifacts/Token.js"
import { DripperContractArtifact } from "@defi-wonderland/aztec-standards/dist/src/artifacts/Dripper.js"

const findToken = (symbol: string) => {
  const t = deploymentsJson.tokens.find(t => t.constructorArgs.symbol === symbol)
  if (!t) throw new Error(`deployments.json missing token: ${symbol}`)
  return t
}

export const DRIPPER = AztecAddress.fromString(deploymentsJson.dripper.address)
export const USDC = AztecAddress.fromString(findToken("USDC").address)
export const ETH  = AztecAddress.fromString(findToken("ETH").address)
```

The frontend never reads contract addresses from env. Build-time constant.

---

## 9. Build & hosting

**Build**: `bun run --cwd packages/faucet build` → `packages/faucet/dist/`.
~5-6 MB total (bb.js dominates). Acceptable for internal audience.

**Required headers** — bb.js needs cross-origin isolation for threaded
wasm. Ship as `public/_headers` (Cloudflare Pages respects it natively):

```text
/*
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
  Content-Security-Policy: default-src 'self'; img-src 'self' data:; font-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self' https://*.aztec.network wss://*.aztec.network; object-src 'none'; base-uri 'self'; frame-ancestors 'none'
  X-Content-Type-Options: nosniff
```

Same headers set via `vite.config.ts:server.headers` in dev.

**Hosting recommendation**: **Cloudflare Pages**.
- Free tier handles our bandwidth and bundle size.
- Native `_headers` support → no edge function needed for COOP/COEP.
- GitHub integration: push → preview deploy.
- All assets same-origin (we self-host fonts and favicons).

Pages setup (one-time):
- Project root: `packages/faucet`
- Install: `bun install --frozen-lockfile`
- Build: `bun run build`
- Output: `dist`

Custom domain deferred — see §13.

**Not Vercel** (spend-cap risk on bb wasm). **Not GitHub Pages** (no
custom-header support).

---

## 10. CI gates

Faucet auto-included in:
- `bun run lint` (root biome covers `packages/**`)
- `bun run typecheck:all` (root workspace filter)
- `bun run test:all` (same filter)

Root `package.json` additions:
- `dev:faucet`: `bun run --cwd packages/faucet dev`
- `build:faucet`: `bun run --cwd packages/faucet build`
- `test:faucet`: `bun run --cwd packages/faucet test`

New root script:
- `audit:full`: `typecheck:all && test:all && lint && build && build:faucet`

GitHub Actions: `_lint-and-typecheck.yml` already triggers on
`packages/**` — faucet picked up.

New advisory workflow `Faucet smoke / Status`: runs `bun run --cwd packages/faucet test:e2e` on PRs touching `packages/faucet/**`. Advisory at first; required after one green week.

Network e2e: not in v1.

---

## 11. Risks & open questions

1. **`deployments.json` is deploy metadata, not a registerable `ContractInstance`** `[codex, opus]`. `lib/contracts.ts` MUST reconstruct via `getContractInstanceFromInstantiationParams(artifact, {constructorArgs, salt, publicKeys: PublicKeys.default(), deployer: AztecAddress.ZERO, constructorArtifact})`. Tested in `deployments.test.ts`.

2. **aztec-standards artifact import path** `[codex]`. Use the proven path the Nulo wallet uses: `@defi-wonderland/aztec-standards/dist/src/artifacts/{Token,Dripper}.js`. Confirm in Phase A.

3. **`aztec-standards/scripts/deploy.ts` is not exported in the npm package**. We vendor ~150 lines into `packages/faucet/scripts/deploy.ts`. Cite source. Risk: low — the logic is stable.

4. **alpha-testnet SponsoredFPC reliability** is external. If their FPC quota is exhausted or the contract is down, every drip fails. **No mitigation** in the faucet — surface error clearly + document in README. Wallet-agnostic explicit `feePayer` is the right choice precisely because the Nulo wallet's own fee picker is also a single point of failure.

5. **Account-not-deployed gotcha**. Newcomers hit a cryptic "nullifier" error on first tx. **Mitigation**: pre-flight `node.getContract(account)` on connect; show banner with friendly fix copy.

6. **Private drip is slow** `[opus]`. Proving + note delivery takes 30-90s on alpha-testnet. UI shows `Submitting in wallet…` with the note "Private drips take 30-90 seconds. Stay on the page." 2-minute soft timeout → `Still working — check your wallet.`

7. **bb.js bundle size** ~5-6 MB. v1 ships it. Internal audience tolerates. Lazy-load is a follow-up if perf complaints arrive.

8. **Salt 1337 collision with Wonderland's deployed Dripper**. If they already have a Dripper at salt 1337 on alpha-testnet, our address collides to theirs. That's actually fine — we share their Dripper. Tokens get our own salts (4242, 4243) to avoid colliding with their WETH/DAI/USDC.

9. **No persistent wallet state on refresh**. Browser refresh re-discovers. Acceptable for internal tool. Defer auto-reconnect.

10. **Test-token name confusion**. "USDC" + "ETH" matches mainnet brands; the `Test token · no real value` chip mitigates but the risk persists. Re-evaluate after first Foundation feedback round.

---

## 12. Non-goals (explicit)

- Multiple networks · network switcher · sandbox toggle
- Multiple drip amounts · user-configurable amounts · chips
- Rate limiting (none — trust the audience)
- Backend · server · database · analytics
- Custom wallet UI (use SDK as-is)
- i18n (English only)
- Mobile-first layout (responsive-default suffices)
- Activity history beyond session (no localStorage / no backend)
- Storybook for faucet components
- Visual regression testing
- Lighthouse a11y CI gate (manual check only)
- Custom dripper contract (use Wonderland's)
- Extracting a shared UI package
- React port
- More than 2 tokens
- Account switcher · wallet picker UI (auto-pick first)
- Auto-reconnect across refresh
- Swap UI · transfer-between-users · balance history page
- Wallet creation/recovery/onboarding inside the faucet
- CHANGELOG entries · marketing copy
- Production observability (no Sentry)
- Keyboard shortcuts beyond standard tab order
- Dark/light theme toggle (one theme — brutalist dark with cream accent)

---

## 13. The one question I'd ask the user

**Two decoupled questions, both decision-blocking for production but
not for development:**

**(a) Alpha-testnet `chainId` and `version`** `[codex]` — what exact
values should we pin as `VITE_CHAIN_ID` and `VITE_CHAIN_VERSION` so
the faucet doesn't ship with `Fr.ZERO` wildcard matching to prod? We
can fall back to wildcard while we build, but should pin before
hosting publicly.

**(b) Hosting domain** `[mine]` — the host's default domain fine for v1
or do we want a custom domain? Affects the URL we put
in `requestCapabilities.metadata.url` and the explorer-link footer.

Both are configurable via env (`VITE_CHAIN_ID`, `VITE_CHAIN_VERSION`,
`VITE_WALLET_INSTALL_URL`, `VITE_EXPLORER_BASE_URL`) so we can start
without locked answers — just need them before public launch.
