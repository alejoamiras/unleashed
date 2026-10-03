# Recon — unleashed-reskin

Two read-only sweeps against `main`. The first covered the design system, styling, fonts, icons, motion and test coupling. The second covered the app's copy, wallet identity and the faucet-token deploy path. Spot-checks by the planner are marked ✔. Corrections from the plan audits (Codex and Opus) are folded in.

## Reuse map

| Capability needed | Existing code | Verdict |
|---|---|---|
| Theme tokens, dark/light/system switching | `packages/design/src/base.css` (~34 vars, `:root` = dark, `[theme="light"]`), `apps/tools/public/theme-boot.js` (pre-paint, `localStorage["unleashed:theme"]`), `apps/tools/src/composables/useTheme.ts` (`THEME_MODES = dark/light/system`) | **adapt**: new token set, same switching mechanism, same storage key (a protocol string) |
| Ghost-token guard | `packages/design/src/theme-vars.ts` + `theme-vars.test.ts`, re-run for the app by `apps/tools/src/lib/theme-vars.test.ts` (`OWNED_PREFIXES`, `OWNED_EXACT`) | **adapt**: add the new prefix; **keep** the retired prefixes and names owned forever, since dropping one stops the guard seeing leftover references (`theme-vars.ts:12-26`) |
| Contrast guard | `packages/design/src/theme-contrast.ts` + test: AA 4.5:1 over TEXT × SURFACES in both themes plus 3 explicit pairs; a regex resolver (hex/rgb/`color-mix`/`var()`) | **adapt**: replace TEXT × SURFACES with an explicit permitted-pair list. The full product fails by construction in light (ink-3 on band 4.44, signal on paper 2.71) |
| Global element rules | `apps/tools/src/app.css` (27 lines) + `app.css.parity.test.ts`, which asserts page bg/colour/min-height, button cursor, input colour and the focus-visible rule exist in `app.css ∪ base.css` | **reuse**: keep the rules, change values |
| Fonts | self-hosted woff2 in `packages/design/src/fonts/`, `@font-face` at `base.css:10-43`, no preload; all 16 `font-family` uses in the app go through `var(--font-*)` | **adapt**: swap the files and the three `--font-*` values; nothing else references font names |
| CSP | generated in `apps/tools/vite.config.ts:99-114` into `dist/_headers`: `font-src 'self'`, `img-src 'self' data:`, `style-src 'self' 'unsafe-inline'` | **reuse as-is**: self-hosted fonts and `data:` SVG static both fit; Google Fonts would not (✔ no external font host anywhere) |
| Icons | `packages/design/src/core/Icon.vue`: inline stroke SVG, a `GLYPHS` map with one entry (`chevron`), used twice. Material Symbols ligatures only in `ThemeToggle.vue`. Unicode glyph icons (✓ ✕ ⤓ ⧉ ◆ ⚠ ● ▢ ▓ ░) are text nodes in ~12 app components | **adapt** Icon.vue to filled pixel paths; **remove** Material Symbols; replace glyph text nodes with `<Icon>` |
| Raw-HTML ban | `packages/design/src/boundary.test.ts` forbids `v-html` / `innerHTML` in design | **constraint**: icon paths render as `<path :d>` from data, never injected markup |
| Primitives | design `ui/Button` (5 app users), `ui/Card` (TokenCard only), `ui/Tag` (via DisclaimerTag), `ui/Toast` (AppToastRegion), `ui/Spinner` (Button only), `core/Flex`, `composite/*` (AddressDisplay, BalanceRow, DisclaimerTag, DripButton, EmojiGrid) | **adapt** each in place |
| App chrome | 40 of 41 app `.vue` files carry scoped `<style>` (~3,437 lines). Shell: `AppShell.vue` (grid 200 / 1fr / dock), `SectionHeader`, `RailNav`, `DockStrip`, `ActivityDock`/`ActivityRow`; wizard: `send/WizardShell`, `StepStrip`, `SendWizard` (largest); modals `WalletPickerModal`, `ChooseAccountModal`, `VerificationModal`; toasts `AppToastRegion` | **adapt** file by file; no shared chip or card primitive exists in the app (dedup risk: don't hand-roll a notch per file, see Architecture) |
| Hairline / uppercase idiom | `1px solid` ×65, `text-transform: uppercase` in 24 files, `letter-spacing` ×68, `1px dashed` empty-state ×10, `inset` box-shadow selection ×4, `rgba(0,0,0,0.7)` modal backdrops ×3, `border-radius` ×2 (brand mark) + Spinner | **adapt**: the change surface |
| Motion | `pulse` (AztecWalletPanel, WalletPickerModal, BridgePhaseRail), `stamp` (BridgePhaseRail), `confetti-fall` (BridgeReceipt), `stamp-in` + `flash` (BridgeJournalCard), `spin` (Spinner); `--bezier` token; per-file `prefers-reduced-motion` in 4 files; toast transitions in `base.css:174-186` | **adapt** to stepped tokens; keep every per-file reduced-motion block unless a central rule provably covers it |
| Progress bars | `BridgePhaseRail.vue:54-58` `bar()` builds `▓`/`░` text (8 cells); `BridgeReceipt.vue:126` | **adapt** to a phase-bar element with `role="progressbar"`. `BridgePhaseRail.vue:203-217` is the only file using `::before`/`::after` (3 rules); it keeps them and is not a notch host |
| Wallet identity at runtime | `createAztecWalletSession.ts`: `discoveredWallets` (name, icon; picker only), `preferredWalletName` (persisted `{id,name}`, no icon), read by `AztecWalletPanel.vue:128` "Connect {{ shortPreferredName }}"; sanitizers `displayName()` / `safeIcon()` in `WalletPickerModal.vue` | **adapt**: `displayName()` only truncates (`WalletPickerModal.vue:26`), and `writePreferred` truncates without stripping (`createAztecWalletSession.ts:298`); stripping happens only on read (`:286`). Build one `sanitizeWalletName` (strip, then truncate) and use it at write, read, picker display and `walletLabel` |
| Faucet catalog | `apps/tools/src/constants/tokens.ts`, `scripts/deploy-config.ts` (salts 4244/4245; 4242/4243 retired), `src/contracts/deployments.{json,ts}`, `scripts/verify-deployments.ts` (recomputes addresses from constructor args ✔), **and** a second literal catalog in `packages/bridge-core/scripts/sandbox/drip.ts:16-19` ✔ | **adapt**: one dependency-free `packages/bridge-core/src/faucet-catalog.ts` exported from `"."`. Scripts are not package exports, and `./sandbox` is Node-only. `verify-deployments.ts:52,100` and `deploy.ts:103` also hardcode the tickers |
| Deploy | `apps/tools/scripts/deploy.ts`: universal deploy (`deployer = AztecAddress.ZERO`), `--dry-run`, writes `deployments.candidate.json` (`--allow-live-output` writes live directly, `:79-86`); secrets `DEPLOYER_SECRET` or `DEPLOYER_SECRET_KEY` + `DEPLOYER_SALT`. The deploying account does not affect addresses, and testnet fees are sponsored. The PXE persists derived keys under `.tools-deploy-<network>/` (`deploy-config.ts:57`). `live-intent.ts promote` needs the bridge candidate and the L1 bridge signer and has no faucet-only mode (`:577-590,702-712`). Dripper (salt 1337) mints for any token naming it as minter, so **no Dripper redeploy** | **adapt**: throwaway deployer, per-run PXE dir, faucet-only candidate → verify → canary → copy |
| Live check | `packages/bridge-core/scripts/drip-canary-testnet.ts`: rebuilds instances from `deployments.json`, drips from a fresh L2 account via the Sponsored FPC, needs no keys ✔; hardcodes `symbol === "TKA"` | **adapt** |
| Sandbox e2e | `bun run e2e:tools` (`apps/tools/scripts/e2e/agent.sh`, run-isolated); sandbox tokens come from `packages/bridge-core/scripts/sandbox/deploy.ts` → `deployDripFixture()`, not `deploy.ts` | **reuse** |

## Test coupling (what a reskin can break)

- **No snapshot tests** (searched `toMatchSnapshot|toMatchInlineSnapshot`, `.snap`, `__snapshots__`: none).
- **Class assertions**, all semantic state classes that must survive:
  - `ActivityDock.test.ts:197` (`overlay`)
  - `BridgePhaseRail.test.ts:106-116` (`landed`, `pulse`)
  - `ActivityRow.test.ts` (`filled`, `dim`)
  - `RailNav.test.ts:42` (`.count`, `hot`)
  - `AztecWalletPanel.test.ts:128` (`denied`)
  - `send/WizardShell.test.ts:87` (`sr-only`)
  - `BridgeJournalCard.test.ts` (`other`)
  - `WalletPickerModal.test.ts:97` (`.name`)
  - `Footer.test.ts:50` (`.contracts`)
  - Playwright `registration-retry.spec.ts:108` (`.status-text`)
- **Literal copy and glyph assertions** that the reskin changes on purpose:
  - `VerificationModal.test.ts:28` "VERIFY THE GRID"
  - `BridgePhaseRail.test.ts:96` "CROSSING"
  - `BridgeReceipt.test.ts:35` `toBe("✓")` ✔
  - `TokenCard.test.ts:87`, the first faucet token's symbol
- **Playwright** selects by `data-testid` everywhere else.
- **Literal casing assertions** (sentence case changes them on purpose). The uppercase lives in TS and template literals as well as CSS: `bridge-steps.ts:127-135`, `ActivityRow.vue:23-33`, `BridgeJournalCard.vue:85` (`.toUpperCase()`) and `:277-413`, `ReviewStep.vue:155`, `MintStrip.vue:103`, `ChoiceCards.vue:48-49`, `AmountStep.vue` nav buttons, `network.ts:65` (`L1_CHAIN_LABEL`). About 30 unit assertions follow them, plus the jsdom smoke (`tests/e2e/shell-smoke.test.ts:136`) and Playwright `accounts.spec.ts:109` ("SWITCH TO"). Implementation re-greps each file's assertions before editing it.
- **Glyph assertions:** `BridgePhaseRail.test.ts:61` (`/▓+░+/`), `ActivityRow.test.ts:28`, `BridgeJournalCard.test.ts:139`, `BridgeReceipt.test.ts:35` (all "✓").
- **Design package guards:** `mount-all.test.ts` mounts 4 primitives (not every export); `boundary.test.ts` forbids chrome APIs, vue-router and raw HTML.

## Copy — the 8 user-visible lines that name the wallet

`AztecWalletPanel.vue:121-122` (title + "Install Nulo") · `lib/errors.ts:31` · `lib/bridge-steps.ts:139,159` · `TokenCard.vue:165` · `send/SendWizard.vue:1095` · `views/MainnetPlaceholderView.vue:11` (the link text is the wallet's site). Plus the token tickers in the `ActivityView.vue` line ending "fixed drip · no rate limit" and in the `Footer.vue` "Contracts:" line. `index.html` is already generic. Its description "Test USDC and ETH…" is stale.

## Absence claims and their search trails

- **No external font host.** Searched `fonts.googleapis|gstatic` in `apps/tools` and `packages/design` (.ts .vue .css .html .jsonc).
- **No `_headers` or wrangler header config.** Searched with `find -iname _headers` and the wrangler files; the CSP is only in the Vite plugin.
- **Spinner and Tag are not used directly by the app.** Searched `\bSpinner\b`, `\bTag\b` in `apps/tools/src`.
- **Material Symbols appear only in ThemeToggle.** Searched `material-symbols-outlined|MaterialSymbols`.
- **No persisted record stores a drip symbol.** `useDrip.ts` state is in-memory, and the bridge journal keys arbitrary ERC-20s, so the token rename cannot orphan user data.
- **No live mainnet faucet.** The mainnet build renders only `MainnetPlaceholderView` (`App.vue:16`), so `DripView`'s `IS_MAINNET` branch (`DripView.vue:25`) and the mainnet fee path (`useDrip.ts:79`) are dormant. There is no `deploy:mainnet` script. The dormant copy is still renamed.
- ~~No token logo assets~~ **Wrong:** `src/assets/token-sprite.svg` exists (hardcoded disc colours, `font-family="monospace"`), and `public/favicon.svg` is the round mark. Both are in the change map.
- **Only 3 `::before` / `::after` rules**, all in `BridgePhaseRail.vue:203-217`. Collisions are few, but the notch still needs rules for popover hosts (`AccountSwitcher.vue:298-302` `.menu`), inputs, and `overflow: hidden` nodes (`BridgeReceipt.vue:183`).
