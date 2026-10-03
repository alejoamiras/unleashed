# Faucet → Bridge-Frontend: Research Document

**Scope:** Unified tabbed Vue 3 Faucet+Bridge app. Locked decisions: Vue 3 with brutalist design; `@unleashed/design` package extraction seeded from the faucet; L1 via `@wagmi/vue` + viem (no React); `packages/faucet` → `packages/bridge-frontend`; Aztec pinned 4.2.0; Cloudflare Pages hosting.

---

## Purpose

This document answers five questions needed before the blueprint:

1. How does the faucet work today — what is reusable as the "Faucet tab"?
2. What tokens/components seed `@unleashed/design` and how should that package be structured?
3. How do we add tabs to a currently router-free app, and how does Cloudflare Pages hosting change?
4. Is `@wagmi/vue` + viem viable for Vue 3 L1 wallet (MetaMask/injected) + Permit2 EIP-712 signing?
5. What does the `packages/faucet` → `packages/bridge-frontend` rename touch in CI?

---

## Faucet Anatomy (reusable as Faucet tab)

### Wallet connection (`packages/faucet/src/composables/useWalletConnection.ts`)

Module-level singleton pattern: `status`, `verificationEmojis`, `accounts`, `selectedAccount`, `error`, `wallet` are all module-level `ref`s, making the composable behave as a shared store across all callers in the same tab.

Connection lifecycle (7 states: `idle → discovering → verifying → capability-approval → setting-up → connected → error`):

1. `connect()` — calls `WalletManager.configure({ extensions: { enabled: true } })` and iterates `discovery.wallets` (async generator); takes the first provider.
2. `establishSecureChannel(APP_ID)` — opens the secure channel, returns a `PendingConnection` whose `verificationHash` is rendered as emoji (3×3 grid).
3. `confirmVerification()` → `pending.confirm()` → calls `requestCapabilities()`.
4. `requestCapabilities()` — sends a typed manifest (`buildFaucetManifest`) to the wallet; extracts granted accounts from the result; then calls `registerFaucetContracts()`.
5. `registerFaucetContracts()` — calls `wallet.registerContract(instance, artifact)` for Dripper + USDC + ETH; uses `getContractInstanceFromInstantiationParams` to reconstruct live instances from `deployments.json`.
6. On wallet-side disconnect, `onDisconnect` callback fires `cleanupSession()` and resets status to `idle`.

The wallet's schema-patch import is the first import in `useWalletConnection.ts` — it must remain first in whatever module eventually imports it.

### Token model (`packages/faucet/src/constants/tokens.ts`)

Two tokens: USDC (decimals=6, drip=1,000 = `1_000_000_000n`) and ETH (decimals=18, drip=1 = `1_000_000_000_000_000_000n`). Typed as `FaucetToken`. The `onchainAmount` goes directly to the Dripper's `amount: u64` param.

### Contract deployments (`packages/faucet/src/contracts/deployments.ts` + `deployments.json`)

`deployments.json` is committed and contains constructor params + salt that allow `getContractInstanceFromInstantiationParams` to recompute deterministic addresses. The three exported constants (`DRIPPER`, `USDC`, `ETH` as `AztecAddress`) are imported throughout. `rebuildDripperInstance` / `rebuildUsdcInstance` / `rebuildEthInstance` are the lazy builders.

### Drip logic (`packages/faucet/src/composables/useFaucetDrip.ts`)

Stateless composable (receives `wallet: Wallet, account: AztecAddress`). Module-level `inflight` ref gates concurrent drips. The drip path:

- Gets `Contract.at(DRIPPER, DripperContractArtifact, wallet)`
- Calls `drip_to_public` or `drip_to_private` method
- Wraps with `SponsoredFeePaymentMethod(sponsoredFpc.address)` via `.request({ fee })`
- Sends with `wallet.sendTx(exec, { from: account })`
- Returns `{ kind: "txHash", value }` or `{ kind: "error", value }` via `DripResult`

### Balance polling (`packages/faucet/src/composables/useTokenBalance.ts`)

Polls every 15s via `setInterval`. Two read paths diverge by Aztec function kind:

- `balance_of_public` (`#[external("public")] #[view]`) → `interaction.simulate({ from })` → extracts `.result` (SimulationResult wrapper).
- `balance_of_private` (`#[external("utility")]`) → `method(account).request()` → `wallet.executeUtility(call, opts)` → extracts `result[0]` (UtilityExecutionResult).

Returns `UseTokenBalanceHandle` with `publicBalance`, `privateBalance`, `loading`, `error`, `refresh()`, `dispose()`. Caller owns dispose (called in `onBeforeUnmount`).

### Add-to-wallet (`packages/faucet/src/composables/useFaucetAddToken.ts`)

Calls the Nulo wallet's custom `registerToken` RPC on the connected wallet (patched in via the wallet's schema patch). Returns typed `AddTokenStatus` union: `idle | submitting | ok | rejected | unsupported | error`.

### Supporting libs (all reusable as-is)

- `lib/capabilities.ts` — `buildFaucetManifest()`, tight capability scope (no wildcards): accounts.canGet, contracts [DRIPPER, USDC, ETH], simulation utilities (balance_of_private), simulation transactions (balance_of_public), transaction scope (drip_to_public, drip_to_private, sponsor_unconditionally).
- `lib/chain-info.ts` — `readChainInfo()` with URL param → VITE env → testnet defaults (Sepolia 11155111, rollup version 4127419662).
- `lib/errors.ts` — `normalizeError()` with 9 categories: user-rejected, capability-rejected, no-wallet, network, tx-reverted, no-fee-asset, account-uninitialized, contract-not-registered, unknown.
- `lib/explorer.ts` — `explorerTxUrl` / `explorerAddressUrl` using `VITE_EXPLORER_BASE_URL`, aztecscan URL shape `/tx-effects/<hash>` and `/contracts/instances/<addr>`.
- `lib/format.ts` — `formatBigInt(value, decimals, displayPlaces=2)`, `trimAddress`, `trimTxHash`.
- `lib/testids.ts` — `TESTIDS` const with `fa-` prefix for all interactive elements.
- `composables/useToast.ts` — module-level singleton, TTL-based queue (max 4 items, 6s default), returns `{ toasts, push, dismiss }`. `push()` returns the toast id for tracking.
- `contracts/sponsored-fpc.ts` — `getSponsoredFpcInstance()` with module-level cache; derives deterministic SponsoredFPC address from `SPONSORED_FPC_SALT`.

### Reusability verdict

All composables, contracts logic, lib utilities, and `deployments.json` + deploy script are the "Faucet tab" and can be moved verbatim to `packages/bridge-frontend/src/faucet/` with no changes beyond import path updates. The only shared infrastructure is `useToast` (module singleton) — it must remain in a shared location or be promoted to a store.

---

## `@unleashed/design` Extraction — Component/Token Inventory, Packaging

### What the faucet has (the extraction seed)

**Design tokens** (`packages/faucet/src/design/tokens.ts`):
- `surfaces` (8 vars: appBg, cardBg, tooltipBg, dropdownBg, and the four earlier surface tokens: base, low, high, highest)
- `brand` (4 vars: accent, secondary, outline, border)
- `text` (7 vars: primary, secondary, body, tertiary, support, white, inverse)
- `borders` (2 vars)
- `button` (2 vars: primaryBg, redBg)
- `colors` (11 vars: white, black, blue, green, mint, neutralMint, orange, yellow, red, gray, sand)
- `fonts` (3 vars: headline, body, mono)
- `motion` (1 var: bezier)
- `CssVarName` union type + `cssVar()` helper

Note: faucet `tokens.ts` is a trim of the wallet's `tokens.ts`. The wallet's version adds `colors.purple`, `fontSizes`, `fontWeights`, `lineHeights`, `easings`, `durations`, `layout` (popup-specific), and full TSDoc. The `@unleashed/design` extraction should use the wallet's fuller version as the authoritative source and drop `layout` (popup-specific dimensions).

**Base CSS** (`packages/faucet/src/design/base.css`):
- 3 font-faces: InterVariable (woff2), Space Grotesk (2 woff2 files), JetBrains Mono (woff2)
- Full CSS custom property definitions at `:root` (dark theme only — faucet has no light/dark toggle)
- Reset rules (`box-sizing`, `margin: 0`, etc.)
- Vue transition classes: `fade-enter/leave`, `toast-enter/leave`
- Font files live at `/public/fonts/*.woff2` (served as static assets by Cloudflare Pages)

**UI components** (pure, no service dependencies):
- `components/ui/AppButton.vue` — variants: primary/outline/ghost; loading spinner integration; `disabled` + `loading` props; emits `click`
- `components/ui/Card.vue` — slot wrapper with the earlier `surface` token + border + padding
- `components/ui/Spinner.vue` — CSS-only border-rotation spinner, `size` + `label` props
- `components/ui/Tag.vue` — tones: neutral/test/warn; mono font; border box
- `components/ui/Toast.vue` — kinds: ok/error/info; border-left color accent; optional link; dismiss button; `role="status"` + `aria-live`

**Composite components** (no service/store dependencies — safe for L3):
- `components/composite/AddressDisplay.vue` — truncate + clipboard copy, `head`/`tail` props, hover-to-reveal copy state
- `components/composite/BalanceRow.vue` — renders public + private `bigint | null` values; uses `formatBigInt`; references `TESTIDS`
- `components/composite/DisclaimerTag.vue` — thin wrapper: `<Tag tone="test">Test token · no real value</Tag>`
- `components/composite/DripButton.vue` — thin wrapper: `<AppButton variant="outline" :loading :disabled>`
- `components/composite/EmojiGrid.vue` — 3×3 emoji grid for wallet verification; `toGrid(emojis)` from `lib/emoji`

**App-level components** (faucet-specific, not for `@unleashed/design`):
- `WalletPanel.vue` — consumes `useWalletConnection`, has 5 conditional render branches
- `TokenCard.vue` — orchestrates drip + balance + add-token composables
- `VerificationModal.vue` — Teleport to body, emoji grid modal
- `AppToastRegion.vue` — fixed-position toast list with `TransitionGroup`
- `Footer.vue` — contract links + attribution

The faucet's base.css is manually flattened and dark-only. The extraction must decide: (a) keep the faucet's plain-CSS pattern, or (b) introduce SCSS as a build dependency. Recommendation: stay plain CSS for `@unleashed/design` v1 (the faucet has no SCSS in its pipeline currently), and add a light-theme block only if the bridge UI needs it.

### Packaging strategy for `@unleashed/design`

**Package identity:** `packages/design/` as a Bun workspace package with `"name": "@unleashed/design"`.

**Package exports map:**
```json
{
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    },
    "./tokens": {
      "types": "./dist/tokens.d.ts",
      "import": "./dist/tokens.js"
    },
    "./base.css": "./src/base.css"
  }
}
```

The CSS file is exported as a direct source path (not a dist path) — consumers import it as a side-effect and Vite processes it through the consumer's own pipeline (font-face `url()` paths resolve relative to the consumer's public dir). This matches how the faucet currently works: `import "./design/base.css"` in `main.ts`, with font files in `public/fonts/`.

**Font file strategy:** Font files (`InterVariable.woff2`, `SpaceGrotesk-*.woff2`, `JetBrainsMono-*.woff2`) are NOT bundled inside `@unleashed/design`. Each consuming app is responsible for providing them in its own `public/fonts/` directory. The `base.css` assumes `/fonts/*.woff2` as the URL — this is the Cloudflare Pages static asset convention already in use. This avoids the `file://` vs `http://` URL resolution problem.

**Component exports:** Vue SFCs are distributed as source (`.vue` files), not pre-compiled. Consumers' Vite + `@vitejs/plugin-vue` handles the compilation. This means `@unleashed/design` needs no build step for components — just a `tsconfig.json` and a `package.json` with `exports`.

**Vite alias in consuming apps:** Each consumer configures `"@unleashed/design": resolve(pkgRoot, "packages/design/src")` in `vite.config.ts` for dev. In CI / production, Bun workspace resolution via the `exports` map handles it.

**Biome layer rules for `@unleashed/design`:** The `@unleashed/design` package is a new leaf — other packages can import it, it imports nothing from the other workspace packages. Add a biome override that bans all workspace-package imports from `packages/design/src/**` except itself. Also add `noRestrictedGlobals` banning `chrome.*` and `window.chrome`. The design tokens and components must remain platform-agnostic.

---

## Unified Tabbed App + Cloudflare Hosting

### Current routing situation

The faucet has NO router. `App.vue` is a flat page: `<header>` → `<WalletPanel>` → `<section class="cards">` → `<Footer>` → `<AppToastRegion>`. There is no `vue-router` in `package.json`.

### Tab state: vue-router vs simple reactive state

**Option A: Simple reactive tab state (recommended for v1)**

```ts
// src/state/tab.ts
const activeTab = ref<'faucet' | 'bridge'>('faucet')
```

Pros: zero additional dependency; no URL routing complexity; the faucet's e2e selectors use `data-testid` (not URL paths) so they're unaffected; Cloudflare Pages serves a single-page SPA anyway (the `_headers` file has no URL routing rules that would conflict).

Cons: deep-linking to the bridge tab requires a query param or hash; browser back/forward doesn't switch tabs.

**Option B: vue-router with hash mode**

`createRouter({ history: createWebHashHistory() })` — hash routes don't require server-side catch-all rules. Cloudflare Pages would serve `index.html` for all routes automatically.

**Option C: vue-router with history mode + Cloudflare Pages catch-all**

Cloudflare Pages serves `404.html` or a redirects file for SPA routing. Standard approach: add `[[fallback]]` or a `_redirects` file (`/* /index.html 200`). The existing `_headers` file already applies the CSP to all routes (`/*`).

**Recommendation:** Start with Option A (tab state in a `ref`). Add vue-router only if deep-linking becomes a requirement. The two-subdomain idea (see below) makes Option A more natural.

### Two-subdomain idea

One Cloudflare Pages project, one build, one `dist/`. The default tab can be controlled by a `VITE_DEFAULT_TAB` environment variable set per deployment, or by detecting `window.location.hostname` at runtime:

```ts
// src/state/tab.ts
function detectDefaultTab(): 'faucet' | 'bridge' {
  if (typeof window === 'undefined') return 'faucet'
  return window.location.hostname.startsWith('bridge') ? 'bridge' : 'faucet'
}
const activeTab = ref<'faucet' | 'bridge'>(detectDefaultTab())
```

Cloudflare Pages supports custom domains — both subdomains can point to the same Pages project. The hostname detection at runtime requires no build-time divergence.

**Alternative with two builds:** `VITE_DEFAULT_TAB=bridge bun run build` produces a bridge-default bundle. Two Cloudflare deployments from the same repo pointing at different `dist/` artifacts. This is more complex for CI and is not recommended.

### deploy.ts and deployments.json

`scripts/deploy.ts` deploys Aztec contracts (Dripper, USDC, ETH) to testnet. It is faucet-specific and doesn't need to be merged with any bridge deployment. Bridge L1 contracts (if any) would be deployed separately and their addresses committed analogously to `deployments.json`. The deploy script lives in `packages/bridge-frontend/scripts/` after the rename.

### Cloudflare Pages config

The existing `packages/faucet/public/_headers` file ships with:
- `Cross-Origin-Opener-Policy: same-origin` (required for bb.js threaded WASM)
- `Cross-Origin-Embedder-Policy: require-corp` (ditto)
- CSP: `script-src 'self' 'wasm-unsafe-eval'`, `worker-src 'self' blob:`, `connect-src 'self' data: blob: https://*.aztec.network wss://*.aztec.network`

The bridge tab needs L1 RPC calls (Ethereum/Sepolia). The CSP `connect-src` must be extended to include the L1 RPC endpoint (e.g., `https://*.infura.io`, `https://*.alchemy.com`, `https://sepolia.infura.io`, or a self-hosted RPC URL via `VITE_L1_RPC_URL`). This is a one-line change to `_headers`.

---

## Vue + L1 Wallet / Permit2 Verdict

### @wagmi/vue vs @wagmi/core vanilla

**`@wagmi/vue`** is the official first-party Vue 3 adapter (source: [wagmi.sh/vue/getting-started](https://wagmi.sh/vue/getting-started)). It provides Vue composables that wrap `@wagmi/core` actions. It is NOT React — it is a separate package specifically built for Vue 3.

**`@wagmi/core`** is the framework-agnostic core. It can be used directly without any adapter, via imperative action calls. This is viable but results in more boilerplate (manual reactive state management for connection status, etc.).

**Verdict:** Use `@wagmi/vue` for the bridge tab. It provides `useConnect`, `useDisconnect`, `useAccount`, `useSignTypedData`, `useSendTransaction`, and the `WagmiPlugin` for `app.use(...)`. The bridge tab composables become idiomatic Vue 3 — same pattern as the Aztec-side composables.

### Connection pattern for `@wagmi/vue`

```ts
// src/bridge/wagmi.config.ts
import { createConfig, injected, http } from '@wagmi/vue'
import { sepolia } from 'viem/chains'

export const wagmiConfig = createConfig({
  chains: [sepolia],
  connectors: [injected()],
  transports: { [sepolia.id]: http() },
})
```

```ts
// main.ts
import { WagmiPlugin } from '@wagmi/vue'
import { wagmiConfig } from './bridge/wagmi.config'
app.use(WagmiPlugin, { config: wagmiConfig })
```

The `injected()` connector discovers EIP-6963 providers (MetaMask, Rabby, etc.) and falls back to `window.ethereum`. No special per-wallet configuration needed.

### EIP-712 Permit2 signing

Permit2 requires `signTypedData` with:
- `domain: { name: 'Permit2', chainId, verifyingContract: PERMIT2_ADDRESS }`
- `types: { PermitTransferFrom: [...], TokenPermissions: [...] }`
- `primaryType: 'PermitTransferFrom'`

In `@wagmi/vue`:
```ts
const { signTypedDataAsync } = useSignTypedData()
const signature = await signTypedDataAsync({
  domain: { name: 'Permit2', chainId: sepolia.id, verifyingContract: PERMIT2_ADDRESS },
  types: { ... },
  primaryType: 'PermitTransferFrom',
  message: { permitted: { token, amount }, spender: BRIDGE_ADDRESS, nonce, deadline },
})
```

This is fully supported. The `useSignTypedData` composable (source: [wagmi.sh/vue/api/composables/useSignTypedData](https://wagmi.sh/vue/api/composables/useSignTypedData)) wraps viem's `signTypedData` action and handles the wallet connection state internally.

### Sending the bridge transaction

After signing, the bridge deposit transaction is submitted via `useSendTransaction` or `useWriteContract` (if calling a contract ABI). The flow:

1. `signTypedDataAsync(permit2Params)` → `signature`
2. `sendTransactionAsync({ to: BRIDGE_ADDRESS, data: encodeABI(...) })` or `writeContractAsync(...)` with the signed permit + signature.

Both calls go through the same connected L1 wallet (MetaMask/injected). No React context needed.

### Dual-wallet UX: Aztec + L1 simultaneously

The bridge tab needs BOTH wallets connected:

- **Aztec wallet** (the Nulo wallet): managed by `useWalletConnection` (module-level singleton, already established in the Faucet tab if the user connected there). The bridge tab reuses the same ref.
- **L1 wallet** (MetaMask/injected): managed by `@wagmi/vue`'s global state via `WagmiPlugin`.

The two connection lifecycles are independent:
- The Aztec wallet uses discovery + secure channel + capability approval.
- The L1 wallet uses EIP-1193 / EIP-6963 via wagmi's `connect()`.

**UX model for the bridge tab:**
```
Step 1: Connect Aztec wallet (reuse existing WalletPanel, same state)
Step 2: Connect L1 wallet (new L1WalletPanel component using useConnect from @wagmi/vue)
Step 3: Enter bridge amount
Step 4: Approve Permit2 (signTypedData on L1 wallet)
Step 5: Send bridge transaction (sendTransaction on L1 wallet)
Step 6: Poll for L2 receipt (Aztec wallet side)
```

The `useWalletConnection` module singleton means that if the user connects their Aztec wallet on the Faucet tab and then switches to the Bridge tab, the Aztec connection is already live. This is a UX benefit of the module-level singleton pattern.

**Key constraint:** `@wagmi/vue` requires `app.use(WagmiPlugin, { config })` at the root. This must happen in the shared `main.ts`, not inside a lazy-loaded bridge component. The `WagmiPlugin` has negligible overhead when idle (no L1 wallet connected, no polling).

### Dependency versions

- `@wagmi/vue`: ^2.x (source: [npmjs.com/@wagmi/vue](https://www.npmjs.com/package/@wagmi/vue)) — install alongside `viem` (peer dep)
- `viem`: ^2.x — already a transitive peer of `@aztec/aztec.js` but at a specific version; check for conflict before adding as direct dep.

### COOP/COEP constraint

The faucet (and future bridge-frontend) requires `COOP: same-origin` + `COEP: require-corp` for bb.js threaded WASM. These headers are set in both `vite.config.ts` (dev server) and `public/_headers` (production). The `@wagmi/vue` plugin and viem operate entirely in the main thread — no WASM, no SharedArrayBuffer — so these headers do not conflict with L1 wallet behavior.

---

## CI / Rename Impact

### What changes when `packages/faucet` → `packages/bridge-frontend`

**`.github/workflows/_build-faucet.yml`** — rename to `_build-bridge-frontend.yml`. The `--cwd packages/faucet` flags in all `bun run` steps change to `--cwd packages/bridge-frontend`.

**`.github/workflows/pr-quick.yml`** — four changes:
1. The `paths-filter` block `faucet:` section (line 65-68) changes the glob from `packages/faucet/**` → `packages/bridge-frontend/**`.
2. The `changes.outputs.faucet` / `FAUCET` env var references (lines 29, 35, 68, 103, 127-129) must be renamed or a new `bridge-frontend` output added. Simple rename of the filter key to `bridge-frontend:` and the corresponding output key.
3. The `build-faucet:` job (line 194-201) becomes `build-bridge-frontend:`, calling `_build-bridge-frontend.yml`.
4. The `status:` job's `needs` list (line 210) must include `build-bridge-frontend` instead of `build-faucet`.

**`root package.json` scripts** — the following change:
- `"dev:faucet"` → `"dev:bridge-frontend"` (or keep both for compat)
- `"build:faucet"` → `"build:bridge-frontend"`
- `"test:faucet"` → `"test:bridge-frontend"`
- `"audit:faucet"` → `"audit:bridge-frontend"` (and update all `packages/faucet` → `packages/bridge-frontend` paths within it)

**`packages/faucet/package.json`** — the package name changes with the directory. Since this is `"private": true`, there are no npm consumers to break.

**Bun workspace** — root `package.json` `"workspaces": ["packages/*"]` is a glob and picks up the renamed directory automatically. No change needed.

**`biome.json`** — `"includes": ["packages/**", ...]` glob covers the rename. No change needed.

**`scripts/verify-deployments.ts`** — path references within the script use relative paths from the script's location; unaffected by the package rename as long as the script stays within the package.

**`scripts/deploy.ts`** — `__dirname` relative to the script file; unaffected.

**`vite.config.ts`** (inside the package) — the `@` alias resolves to `./src` which is package-relative; unaffected.

**E2e tests** — the faucet's smoke e2e config (`vitest.e2e.config.ts`) targets `tests/e2e/**/*.test.ts` relative to the package; unaffected by rename.

### What does NOT exist yet (will need to be created)

- `_build-bridge-frontend.yml` (replaces `_build-faucet.yml`, plus a build step for the new `@unleashed/design` package if it needs verification)
- A paths-filter glob for `packages/design/**` in `pr-quick.yml` that triggers the bridge-frontend build (since it's now a dependency)
- A `_build-design.yml` if `@unleashed/design` gets its own typecheck/lint CI step

---

## Open Questions

1. **L1 bridge contract address**: What is the Aztec L1 bridge contract address on Sepolia? Is there a `deployments.json` equivalent for L1? This drives the Permit2 `spender` address and the bridge tx `to` address.

2. **Permit2 or direct ERC-20 approve?** The bridge could use: (a) Permit2 gasless approval (EIP-712 signed off-chain, submitted with the bridge tx), (b) standard `ERC20.approve` → then bridge tx (two on-chain txs), or (c) `ERC20.permit` (EIP-2612, only if the L1 token supports it). This determines whether `useSignTypedData` is in the critical path or optional.

3. **L1 tokens for bridging**: Which token(s) are bridgeable? Sepolia ETH (native, no approve needed) vs ERC-20 USDC-equivalent? The Permit2 path only applies to ERC-20 tokens, not native ETH.

4. **Dual-connection persistence across tabs**: Should the Aztec wallet reconnect automatically if the user refreshes on the Bridge tab? Currently `useWalletConnection` resets to `idle` on page load (no session persistence). If the user lands on the Bridge tab URL directly, they'll need to reconnect both wallets. Acceptable for v1?

5. **Bridge polling**: After submitting the L1 bridge tx, the L2 receipt polling involves Aztec SDK calls. Is there an existing bridge-ready method in `@aztec/aztec.js` for polling L1→L2 message status, or does it need custom implementation?

6. **COOP/COEP + L1 RPC provider**: Some MetaMask iframe injection patterns have historically had issues with strict COEP. Test early that MetaMask's injected provider works normally under `Cross-Origin-Embedder-Policy: require-corp`. This is likely fine (the extension is same-origin) but worth verifying in dev.

7. **`@unleashed/design` release scope**: Should `@unleashed/design` be published to npm, or remain a private workspace package? If private, the alias-based approach is sufficient. If published, the font file distribution strategy needs to change (bundle as `src/fonts/` or document as peer files).

8. **Viem version conflict**: `@aztec/aztec.js@4.2.0` depends on a specific viem version internally. Adding `@wagmi/vue` brings viem as a peer dep. A version mismatch between wagmi's viem peer and aztec's bundled viem could cause dual-viem issues (same class, different module scope). This needs a `bun why viem` check before committing to `@wagmi/vue`.

---

*Web sources consulted: [wagmi.sh/vue/getting-started](https://wagmi.sh/vue/getting-started), [wagmi.sh/vue/api/composables/useSignTypedData](https://wagmi.sh/vue/api/composables/useSignTypedData), [wagmi.sh/core/api/actions/signTypedData](https://wagmi.sh/core/api/actions/signTypedData), [wagmi.sh/core/api/createConfig](https://wagmi.sh/core/api/createConfig), [npmjs.com/@wagmi/vue](https://www.npmjs.com/package/@wagmi/vue).*
