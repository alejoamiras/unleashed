---
plan: unleashed-reskin
tier: mid
driver: claude-code
eli5_mode: artifact
code_review: off
claude_model: opus
budget: "recon 2 agents; codex high; /code-review off"
status: closed
---

## Outcome

- **Status:** closed. All ten phases are ✓. Every review loop converged: the three arc loops and the cross-arc pass.
- **Shipped:** the stack was squash-merged atomically into `main`, after the owner's written sign-off and merge authorization:
  - arc 1: design tokens, fonts, icons and primitives.
  - arc 2: every screen reskinned.
  - arc 3: the SIGNAL/NOISE faucet cutover and the wallet name.
- **Deploy:** Workers Builds deploys testnet from `main`. The testnet SIGNAL/NOISE contracts were deployed in phase 9. Mainnet serves only the placeholder page.
- **Dropped and why** (each tracked in [`follow-ups.md`](../../follow-ups.md)):
  - the decode motion on live values;
  - the pixel search icon;
  - monogram contrast;
  - the SIGNAL/NOISE deploy on mainnet.
  The theme control stayed a cycling button (decision D4).
- **After the merge, the owner reported:** the app under-represents the A′ boards. The feedback names the logo, the nav icons, the token list and icons, and the wallet modal over static. A separate fidelity plan takes that up, working from the boards themselves rather than this plan's keep-the-layout scope.
- **Seeds retired:** the `/goal` and `/loop` seeds below are spent. Never paste them again.

# unleashed-reskin — Dead Channel A′ look, honest wallet voice, SIGNAL/NOISE faucet

Reskin `apps/tools` and `packages/design` from the earlier design system to **Dead Channel A′ "Quiet broadcast"**. Layout, flow, `data-testid`s and behaviour stay unchanged. There is one small addition the owner asked for: the private-amount veil line.

The same stack also:
- gives wallet copy the wallet's own SDK-reported name;
- redeploys the testnet faucet tokens as **SIGNAL/NOISE**.

**Inputs:**
- [`spec.md`](spec.md): tokens, type roles, shapes, motion and component recipes.
- [`recon.md`](recon.md): the reuse map, the test-coupling inventory, and corrections from the audits.
- The design canvas, page "Dead Channel A′ — System".

## Scope

**In:**
- Every screen of the testnet tools app, in dark and light, at desktop, ≤1100 and ≤760.
- The mainnet placeholder page.
- The design package's tokens, fonts, icons, primitives and motion.
- **Sentence case everywhere**: CSS transforms and uppercase literals in TS and templates (owner).
- The veil line "Others on Aztec see ▒▒▒ · you see {amount} {symbol}" under the Private switch (owner).
- Wallet copy using the wallet's own SDK-reported name.
- The faucet token rename with a testnet deploy.

**Out:**
- Layout or flow changes.
- The emoji verification grid's glyphs (frame only).
- Visual screenshot baselines (declined).
- The "decode" number-scramble motion (deferred; see the ledger).
- The receipt "proof print" randomart (dropped; see the ledger).
- A **mainnet** SIGNAL/NOISE deploy: the mainnet build renders only the placeholder (`App.vue:16`), so the faucet is testnet-only. This is recorded as a follow-up.

## Outcome & Quality Bar

**For whom:**
- People using the Unleashed tools app (bridge and testnet faucet), on a laptop or a phone, in either theme, often mid-transaction and watching progress.

**What excellent looks like:**
1. **A′ on every screen.**
   - No 1px hairline boxes, no uppercase copy, no Unicode glyph icons, no ▓░ bars.
   - The pixel face appears only on the wordmark and the receipt's arrival amount.
   - Each screen, shown next to its canvas board, reads as the same design.
   - Each PR attaches screenshots of every screen it changes (both themes; desktop, plus ≤760 for the shell and wizard) and links its testnet preview. The owner signs off in writing before merging, as `AGENTS.md` requires.
2. **Zero behaviour change.**
   - Every existing unit, jsdom-smoke and Playwright test passes.
   - The only assertion edits allowed are casing and glyph changes that the design makes on purpose. Each one is in the inventory (`recon.md` → Test coupling) and named in its commit.
   - No `data-testid` changes.
3. **Accessible by construction.**
   - Every permitted text/surface pair in both themes is at least 4.5:1, enforced by `theme-contrast.test.ts` over an explicit pair list.
   - Status is never shown by colour alone.
   - Focus rings are visible and never clipped by a notch.
   - `prefers-reduced-motion` shows end frames.
4. **Copy with an honest wallet voice.**
   - Wallet prompts use the wallet's own sanitized name, or "your wallet".
   - The faucet drips SIGNAL and NOISE on testnet.

**Good enough:**
- Pixel parity with the boards is not required; where a board and the running layout disagree, the layout wins.
- Light-theme chip tints for attention, lost and lilac are derived here, gated only by the contrast test.

## Assumptions

### Facts (verified)
1. **Theme.** The theme is the `[theme]` attribute on `<html>`, set before paint by `public/theme-boot.js` from `localStorage["unleashed:theme"]`. Modes are dark/light/system (`useTheme.ts`).
2. **Fonts.** Every app `font-family` goes through `var(--font-*)`. The fonts are self-hosted via `base.css:10-43`.
3. **CSP.** `vite.config.ts:99-114` generates `font-src 'self'`, `img-src 'self' data:`, `style-src 'self' 'unsafe-inline'` into `dist/_headers`. `cspFor` is not exported.
4. **Token tests.** `theme-vars.test.ts` flags `var(--x)` under an owned prefix that `base.css` doesn't declare. Removing a prefix from `OWNED_PREFIXES` silently stops that detection (`theme-vars.ts:12-26`). The scanner reads only `.vue`, `.css` and `.scss` files (`theme-vars.ts:52`), so a token name kept in a `.ts` file escapes it. `theme-contrast.test.ts` checks TEXT × SURFACES at 4.5:1 in both themes, with a regex resolver.
5. **Mainnet.** The mainnet build renders `MainnetPlaceholderView` only (`App.vue:16`); `DripView`'s `IS_MAINNET` branch is unreachable. `App.test.ts:35` asserts that mainnet never loads the shell module; nothing here changes that.
6. **Uppercase literals.** Uppercase copy lives in TS and template literals as well as CSS:
   - `bridge-steps.ts:127-135`
   - `ActivityRow.vue:23-33`
   - `BridgeJournalCard.vue:85` (`.toUpperCase()`) and `:277-413`
   - `ReviewStep.vue:155`, `MintStrip.vue:103`
   - `network.ts:65` (`L1_CHAIN_LABEL`)

   About 30 unit assertions, the jsdom smoke (`tests/e2e/shell-smoke.test.ts:136`) and Playwright `accounts.spec.ts:109` ("SWITCH TO") assert those literals. `BridgePhaseRail.test.ts:61` asserts `/▓+░+/`; `ActivityRow.test.ts:28`, `BridgeJournalCard.test.ts:139` and `BridgeReceipt.test.ts:35` assert "✓". The recon inventory lists them all.
7. **User-visible wallet name.** Eight user-visible copy lines name the Nulo wallet.
8. **Wallet sessions.** The Nulo wallet keys sessions by (profile, origin, chain) and computes capability deltas over `manifest.capabilities` only, ignoring metadata. So:
   - The **new SIGNAL/NOISE addresses** cost **every** connection one capability approval, not just faucet users. Grants are exact-address, and the combined manifest grants the drip tokens to every connection (`useWalletConnection.ts:102-108`).
   - These are the Nulo wallet's behaviours, as inspected. Other SDK wallets may behave differently.
9. **Test wallet.** It refuses any app id other than its `TOOLS_APP_ID` (`tests/browser/test-wallet/profile.ts:7`, `main.ts:135`). `tools-smoke.test.ts:129,142` also pins the id.
10. **Wallet name sanitizing.** `displayName()` only truncates (`WalletPickerModal.vue:26-28`). Stripping `UNSAFE_ALIAS_CHARS` (`createAztecWalletSession.ts:88`) happens only on the storage **read** (`:286`); `writePreferred` truncates only (`:298-304`). The class misses U+00AD and U+2060–U+2064. A remembered connect skips `writePreferred` when a stored value exists (`:970-975`), so a stale stored name survives a successful reconnect. Account aliases use the same stripping (`:1092`).
11. **Deploy.**
    - Addresses are derived with `deployer = ZERO` from constructor args plus salt (`deploy.ts:274-298`), and `verify-deployments.ts:52,100` recomputes them. Renaming the tokens therefore changes the addresses.
    - The deploying account doesn't affect the addresses, and testnet fees are sponsored (`archive/aztec-5.0.1-line/lessons/phase-p6.md:39`). The `DEPLOYER_SECRET` path derives a fresh account (`deploy.ts:421-426`).
    - The PXE persists derived keys under `.tools-deploy-<network>/` (`deploy-config.ts:57`, `deploy.ts:319`).
    - `live-intent.ts promote` needs a bridge candidate and the L1 bridge signer. It has `--bridge-only` but no faucet-only mode (`live-intent.ts:577-590,702-712`).
    - `deploy.ts --allow-live-output` writes the live file directly (`:79-86`).
    - `resolveDeployerKeys` prefers `DEPLOYER_SECRET_KEY` + `DEPLOYER_SALT` over `DEPLOYER_SECRET` (`deploy.ts:403-428`). Bun auto-loads `.env` files unless it runs with `--no-env-file`, so an inherited credential or `AZTEC_NODE_URL` can silently take over.
    - An existing contract is accepted without re-checking its initialization (`deploy.ts:243,262`).
    - `deployments.ts:52-63` looks tokens up by symbol **at module load** and throws if the live JSON lacks them. `verify-deployments.ts:31-36` imports that module even under `--config`, and `verify-deployments.ts:52-56,100` hardcodes the symbols.
    - `deployments.json` holds only `tokens[]` and `dripper`, the same shape `deploy.ts` writes to the candidate (`:381`). Every contract deploy is idempotent (`node.getContract` → `[EXISTING]`, `:243-246`), so the Dripper (salt 1337) is recorded unchanged. Copying the candidate over live loses nothing. Bridge records live in separate manifests.
12. **Canary.** `drip-canary-testnet.ts` takes `--config <deployments file>` (`:32-38`), drips from a fresh account with no keys, and hardcodes the first faucet token (`:86`).
13. **Faucet catalog.** The app has `constants/tokens.ts:18` `DRIP_TOKENS`; the sandbox e2e has its own `DRIP_TOKENS` (`packages/bridge-core/scripts/sandbox/drip.ts:16-19`), with a different shape. `bridge-core` exports selected subpaths; `./sandbox` is Node-only.
14. **Icons.**
    - `Icon.vue` has props `name`, `size` (16 is used), `color` (a `TextColorName` building `var(--txt-${color})` dynamically, `:25`) and `rotate` (the open/closed flip at `AccountSwitcher.vue:152`).
    - Both call sites pass `size="16"` as a string (`AccountSwitcher.vue:152`, `AztecWalletPanel.vue:130`), and `size`/`rotate` are typed `number | \`${number}\`` (`Icon.vue:13-19`).
    - Pixelarticons v2.4.0 (MIT) has all 21 mapped names. Some have several `<path>` children (`download` has 3, `coins` 4). All are path-only, with only a `d` attribute (checked upstream).
15. **Pseudo-elements and popovers.**
    - `BridgePhaseRail.vue:203-217` uses `::before`/`::after` (3 rules). `AppShell.vue:138` has `.mark::after`; the new 8×8 mark replaces it.
    - `AccountSwitcher.vue:298-302` has an absolutely positioned `.menu` (z-index 50) inside the header.
    - `BridgeReceipt.vue:183` has `overflow: hidden`.
16. **Previews.** A push of a non-production branch uploads a public testnet preview through Workers Builds (`apps/tools/README.md:132-135`).
17. **More assets and gates.**
    - `src/assets/token-sprite.svg` has hardcoded disc colours and `font-family="monospace"`.
    - `public/favicon.svg` is the round mark.
    - CI runs `test:e2e` (the jsdom smoke) at `_build-tools.yml:44`. `vitest.config.ts` excludes it from `test`.
    - Vite's default `assetsInlineLimit` (4096 bytes) would inline a tiny woff2 as `data:font/*`, which `font-src 'self'` blocks.
18. **Fonts check.** Atkinson Hyperlegible Next ships `tnum`, but its default digits are proportional. fonttools' default layout features drop `tnum` unless told to keep it.
19. **Contrast.** Light ink-3 `#686671` on band is 4.44:1 and fails. `#65636E` passes on paper, sheet and band (5.22 / 5.60 / 4.64). Light signal on paper is 2.71:1, so the accent **text** needs its own token (ribbon, 5.49).
20. **Token remainder.** The token part that arrives (`amount − gas.fuelAmount`, clamped at 0) is computed inline three times: `GasBreakdown.vue:27-31`, `ReviewStep.vue:57-63` and, unclamped, `SendWizard.vue:890`. `GasLegPlan` lives in `lib/send-model.ts:82`. The privacy switch (`AmountStep.vue:214-228`) renders in both directions; on exit it picks the spending balance, so the veil line only makes sense for `l1-to-l2`.
21. **Repo rules (`AGENTS.md`).**
    - A UI change needs the owner's written sign-off, quoted in the plan or PR, and the PR attaches screenshots.
    - Deploy keys are "never created by an agent". Live deploys follow the `bridge-generation` runbook's authorization gate (Q2: explicit authorization naming the env files read).
    - Before a PR, run `bun run audit:tools` and `bun run test:all`.

### Inferences (still unverified)
- I2. A `ul-notch` host with `isolation: isolate` traps descendant popovers. The plan assumes that notching **only leaf surfaces** (buttons, chips, fields, cards with no popover descendants) avoids this. The header, dock and any `.menu` host are never notched. Phase 4 includes a browser check of the account menu.
- I3. The Sixtyfour subset, keeping all four axes, is under 30 KB as woff2. The vendoring step reports the actual size, and if it is over 60 KB the owner is told.
- I5. `pyftsubset` with `--layout-features='*'` keeps `tnum` and the variation tables. The vendoring step checks this: it lists axes and features in `fonts/SOURCES.md`.

### Asks — all resolved
- **A2 — sentence case.** Owner: everywhere, including TS and template literals and their test assertions.
- **A3 — veil line.** Owner: add it, as designed, with a unit test.
- **A4 — deploy identity.** The owner chose **option T** by answering "Throwaway key (Recommended)" to the option described as: *"The agent generates a random single-use key in the deploy's own shell and never prints it. Least privilege: nothing of value is exposed. Needs your written exception to AGENTS.md's 'keys are never created by an agent', scoped to this one testnet deploy."* That answer is the written exception. It covers this plan's phase-9 testnet deploy only; no other key, network or run.

## Architecture & Implementation

### Proposed architecture

**1. Tokens: expand, then contract.**
- **Arc 1 (expand).**
  - `base.css` gains the new semantic set under the owned prefix `--ul-*`, including the two role tokens the audits showed are needed:
    - `--ul-accent-text`: signal in dark, ribbon in light.
    - `--ul-on-signal`: void in dark, ink in light (5.81).
  - Every old name (`--txt-*`, `--app-*`, `--card-*`, `--dropdown-*`, `--red`, `--mint`, `--yellow`, `--sand`, `--bezier`) is **redefined as an alias** through an explicit table in `base.css`.
  - Where an old name serves as both text and fill, it aliases to the **text** role, and its paired inverse aliases so the old pair still passes:
    - light: the earlier `accent` token → `--ul-accent-text` (ribbon), `--txt-inverse` → `--ul-sheet` (5.89:1);
    - dark: the earlier `accent` token → `--ul-signal`, `--txt-inverse` → `--ul-void` (6.41:1).
  - `theme-contrast.test.ts` keeps checking the legacy pairs it checks today until phase 7 deletes the aliases.
  - The app therefore takes on the new palette at once, and every arc stays shippable and accessible.
- **Arc 2 (migrate).**
  - Each component's references are classified per use: text vs fill vs border vs focus. For example, the earlier `accent` token as text becomes `--ul-accent-text`, as a fill `--ul-signal`, as focus `--ul-focus`.
  - The classification is by hand, file by file. No blind one-to-one codemod: the same old name maps to different new names by role.
- **Arc 2 end (contract).**
  - Phase 7 deletes the alias block.
  - The retired prefixes and names **stay in `OWNED_PREFIXES`/`OWNED_EXACT` permanently**, so any leftover reference is an undeclared ghost that fails `theme-vars.test.ts`.

**2. Contrast by explicit pairs.**
- `theme-contrast.ts` checks a declared list of permitted (text, surface) pairs per theme, instead of the full product:
  - ink, ink-2 and ink-3 on every surface;
  - accent-text on void, panel and paper;
  - on-signal on signal;
  - each status colour on its chip bg;
  - focus on void and paper.
- Light ink-3 becomes `#65636E`, so it passes on band too.
- A usage guard (a grep in the phase-7 gate, anchored to a `color:` declaration) forbids `--ul-signal` as text colour. Accent text must use `--ul-accent-text`.

**3. Shared primitives in `packages/design`:**
- **Notch.**
  - Polygon tokens `--ul-notch-2|4|6`.
  - Utility class `ul-notch`: a transparent host with `position: relative; isolation: isolate`, and a `::before` with `inset: 0; z-index: -1; pointer-events: none; background: var(--ul-fill); clip-path: var(--ul-notch)`.
  - `base.css` declares defaults `--ul-fill: var(--ul-panel)` and `--ul-notch: var(--ul-notch-2)`, because the ghost guard requires every owned variable to be declared.
  - Rules (from I2):
    - Only leaf surfaces are notched, never a host of absolutely positioned popovers or menus.
    - `<input>` is never a host; its wrapper is.
    - `BridgePhaseRail` keeps its own `::before`/`::after` and gets no `ul-notch`.
    - Nodes with `overflow: hidden` are fine as hosts, because the fill is inside them.
    - AccountSwitcher's `.menu` may be notched itself; it keeps its absolute positioning.
- **Static.** A `--ul-static` token holding a `url("data:image/svg+xml,…")` with the feTurbulence recipe. Only `.ul-veil` and `.ul-scrim` use it.
- **Icon.**
  - `core/Icon.vue` keeps its **existing API and prop types**: `name`, `size` and `rotate` as `number | \`${number}\``, and `color`. The design uses sizes 12, 16 and 24.
  - `color` resolves through an **explicit map** from `TextColorName` to `--ul-*`, replacing the dynamic `var(--txt-${color})`. The map lives in Icon.vue's script, where the ghost scanner reads it (F4).
  - Path data is generated into `core/icons.ts` as `Record<IconName, { viewBox; d: readonly string[] }>`, keeping every path in source order. It is rendered as `<path v-for :d>` (no `v-html`, per `boundary.test.ts`).
  - `chevron` stays as an alias.
  - A `label` prop, when set, gives the icon `role="img"` and `aria-label`; otherwise it is `aria-hidden`.
- **Motion.**
  - `--ul-tick`, `--ul-tune`, `--ul-converge` plus steps counts.
  - A central `@media (prefers-reduced-motion: reduce)` sets `animation-duration: 0.01ms; animation-iteration-count: 1; animation-fill-mode: both; transition-duration: 0.01ms`, so each animation lands on its final frame.
  - The per-file reduced-motion blocks stay.
- **Wallet name sanitizer.** A pure `sanitizeWalletName(raw)` goes in a new `apps/tools/src/lib/wallet-name.ts`:
  - **Strip** `\p{Cc}` and `\p{Cf}`. Together these cover C0/C1 controls, bidi controls and isolates, zero-width characters, U+00AD, U+2060–U+2064, the BOM and tag characters. Also strip the Hangul fillers U+115F, U+1160, U+3164 and U+FFA0.
  - Then **trim**, then **truncate** by code point.
  - **Used by:** the preferred-wallet read and write, `WalletPickerModal.displayName()`, and account aliases (`:1092`). It replaces `UNSAFE_ALIAS_CHARS`.
  - `walletLabel(name)` = `sanitizeWalletName(name)`, or "your wallet" when that is empty.
  - **Refresh:** a completed connect rewrites the stored name when the provider id matches but the sanitized name differs, so a stale remembered name doesn't outlive a reconnect (F10).

**4. Design primitives are reskinned in place:**
- Button (primary, secondary, quiet, destructive, disabled with an inline reason slot, busy).
- Card, Tag, Toast (4px status edge).
- Spinner becomes the stepped pixel loader.
- EmojiGrid gets a frame only.
- AddressDisplay and BalanceRow use Mono for data.

**5. App reskin, file by file, in screen groups (arc 2).**
- Hairlines, uppercase and letter-spacing go; the primitives come in.
- Selection becomes reverse video.
- Glyph text nodes become `<Icon>`s that keep the accessible text: a visually hidden label where the glyph was the only content.
- `useCompletionToasts.ts:14` stops prefixing glyphs in toast strings; the toast's kind picks the icon.
- `token-sprite.svg` is restyled to the new palette and Mono.
- `favicon.svg` becomes the 8×8 mark.
- Receipt hero: split `{{ amountDisplay }}` and `{{ amountSymbol }}` into two spans (Sixtyfour for the digits, Mono for the symbol). The text content is unchanged.

**6. Veil line (owner addition, phase 5).**
- It is shown only when direction is `l1-to-l2`, Private is on, and a token remainder exists: "Others on Aztec see" + a `.ul-veil` span (role `img`, label "hidden amount") + "· you see {remainder} {symbol}".
- The remainder comes from a new pure `tokenRemainder(amount, gas)` in `lib/send-model.ts` (F20). GasBreakdown, ReviewStep, `SendWizard.vue:890` and the veil line all use it. The clamp changes nothing at `:890`, since the plan builder already guarantees `fuelAmount ≤ units` (`SendWizard.vue:289-292`).
- Full precision via `toDecimalString`, matching GasBreakdown; the symbol goes through `safeDisplay` like ReviewStep.

**7. Copy (arc 3).**
- `errors.ts` and `bridge-steps.ts` take a `walletLabel` parameter instead of hardcoding "Nulo".
- TokenCard and SendWizard toasts read it from `preferredWalletName`.
- The install CTA becomes generic: "No Aztec wallet found." plus a "Get a wallet" button that still opens `VITE_WALLET_INSTALL_URL`.
- The `MainnetPlaceholderView` link text becomes "Wallet site".

**8. Faucet tokens (arc 3).**
- **Catalog.** One dependency-free catalog, `packages/bridge-core/src/faucet-catalog.ts`, exported from `"."`:
  - `FAUCET_TOKENS` holds name, symbol, decimals and salt.
  - `scripts/deploy-config.ts` derives from it in phase 8. `constants/tokens.ts` (display amounts), `deployments.ts` lookups and `sandbox/drip.ts` switch to it at the phase-9 cutover.
  - The name is new on purpose: `DRIP_TOKENS` already means two different shapes.
- **New tokens.** SIGNAL (6 dp, salt 4246) and NOISE (18 dp, salt 4247). A comment records that salts 4242–4245 are retired.
- **Records module.** `rebuildTokenInstanceFrom`, `rebuildDripperInstanceFrom` and the record types move into `contracts/deployment-records.ts`, which imports no JSON. Scripts import from it, so verifying a candidate never loads the live file (F11).
  - The serialized `constructorArgs.symbol` becomes `string`; today it is the union of the two old symbols (`deployments.ts:27`). `FaucetSymbol` narrows only the catalog and the app's consumers.
  - This keeps the verifier generic.
- **Data-driven checks.** `verify-deployments.ts` and the canary check **every** token record in the file they are given: the address recomputes, and the minter is that file's Dripper. They drop the hardcoded symbols, so they pass on the old live file and on the new candidate alike.
- **Deploy isolation (both A4 options):**
  - Commands run from the repository root. `TOOLS_DEPLOY_DATA_DIR` is an **absolute** path: a `mktemp -d` directory (mode 700) under the gitignored `apps/tools/.tools-deploy-*`, removed by a `trap` on EXIT, INT and TERM. `deploy.ts` resolves its candidate output relative to itself (`:77`), so it needs no `--cwd`.
  - Both options disable `.env` loading (`--no-env-file`) and remove `AZTEC_NODE_URL`, so no stray file or endpoint takes over (F11).
  - The canary runs as `env -u AZTEC_NODE_URL bun --no-env-file packages/bridge-core/scripts/drip-canary-testnet.ts --config <candidate>`.
- **Deploy identity: A4, the owner's call (D11).**
  - **Option T (throwaway)** needs a written, narrowly scoped exception to the repo rule "keys are never created by an agent". A fresh random secret is generated in the same shell and never printed:
    `env -u DEPLOYER_SECRET_KEY -u DEPLOYER_SALT -u AZTEC_NODE_URL DEPLOYER_SECRET="$(openssl rand -hex 32)" TOOLS_DEPLOY_DATA_DIR="$dir" bun --no-env-file apps/tools/scripts/deploy.ts --network testnet`
  - **Option K (keyed run)** complies with the rule as written. The owner's testnet deployer (`DEPLOYER_SECRET_KEY` + `DEPLOYER_SALT`) arrives through `env-exec request`, approved with `op-remote`, and streams into that one process. The delivered pair is kept, and the alternate path is removed:
    `env -u DEPLOYER_SECRET -u AZTEC_NODE_URL TOOLS_DEPLOY_DATA_DIR="$dir" bun --no-env-file apps/tools/scripts/deploy.ts --network testnet`
  - Either way, the runbook's Q2 authorization is quoted in `lessons/phase-9.md` before anything is broadcast.
- **Faucet-only promotion.** The bridge promotion machinery is not used:
  1. `deploy.ts --dry-run` computes the expected addresses.
  2. The deploy writes `deployments.candidate.json`.
  3. `verify-deployments.ts --config deployments.candidate.json` checks it.
  4. `drip-canary-testnet.ts --config deployments.candidate.json` drips both tokens from a fresh account.
  5. **Cutover, as one commit:**
     - copy the candidate over `deployments.json`;
     - switch every consumer to the catalog symbols.

  **Byte pins:**
  - The candidate's sha256 is recorded before step 3 and must equal the live file's after the copy.
  - The Dripper record must equal the old live one exactly.
  - Both bridge manifests' sha256 values must be unchanged.

### Key interfaces

```ts
// packages/bridge-core/src/faucet-catalog.ts
export const FAUCET_TOKENS: readonly [
  { readonly name: "SIGNAL"; readonly symbol: "SIGNAL"; readonly decimals: 6; readonly salt: 4246 },
  { readonly name: "NOISE"; readonly symbol: "NOISE"; readonly decimals: 18; readonly salt: 4247 },
]
export type FaucetSymbol = (typeof FAUCET_TOKENS)[number]["symbol"]

// packages/design/src/core/icons.ts (generated by scripts/vendor-icons.ts)
export type IconName = "check" | "close" | "copy" | "download" | "upload" | "arrows-horizontal" | … // mapping table
export const ICONS: Readonly<Record<IconName, { viewBox: string; d: readonly string[] }>>
// Icon.vue props (API and types kept): { name: IconName | "chevron"; size?: number | `${number}`; color?: TextColorName; rotate?: number | `${number}`; label?: string }

// apps/tools/src/contracts/deployment-records.ts (no JSON import)
export function rebuildTokenInstanceFrom(record: TokenDeployment): Promise<ContractInstanceWithAddress>
export function rebuildDripperInstanceFrom(record: DripperDeployment): Promise<ContractInstanceWithAddress>

// apps/tools/src/lib/wallet-name.ts
export function sanitizeWalletName(raw: string, maxCodePoints?: number): string
export function walletLabel(name: string | null): string // sanitized, else "your wallet"
```

### Data and control flow

- **Theme:** unchanged. The `[theme]` attribute selects the `--ul-*` values (and the aliases during arcs 1–2).
- **Wallet voice:** provider name → `sanitizeWalletName` (at write and at read) → `preferredWalletName` → `walletLabel` → copy, through Vue text interpolation only.
- **Faucet:** `FAUCET_TOKENS` → deploy-config → dry run → isolated deploy (A4 identity) → verify the candidate → canary on the candidate → one cutover commit (copy + consumers) → verify live.

### Icon mapping

| Now | Where | Pixelarticons |
|---|---|---|
| ✓ | journal, receipt, phase rail, rows, account lists, completion toasts | `check` |
| ✕ | errors, failed phases, close | `close` |
| ⤓ / ⤒ | bridge direction (BridgeStepper, BridgeJournal, BridgeJournalCard) | `download` / `upload` |
| ⧉ | copy (AccountSwitcher) | `copy` |
| ◆ / ⚠ | WalletPickerModal notes | `warning-diamond` |
| ↗ / `<i>→</i>` | external links (ActivityView:38,41) | `external-link` / `arrow-right` |
| ● / ▢ | phase states | `loader` / `hourglass` |
| chevron | AccountSwitcher, AztecWalletPanel | `chevron-down` (alias `chevron`) |
| dark_mode / light_mode / brightness_auto | ThemeToggle | `moon` / `sun` / `monitor` |
| (new) | rail: Bridge / Activity / Faucet | `arrows-horizontal` / `audio-waveform` / `coins` |
| (new) | toasts and notes | `check`, `square-alert`, `info-box` |

### File-level change map

- **packages/design:**
  - Modify: `base.css`, `theme-vars.ts` (+test), `theme-contrast.ts` (+test), `core/Icon.vue`, all `ui/*` and `composite/*`, `mount-all.test.ts`, README.
  - Add: `core/icons.ts`, `scripts/vendor-icons.ts`, `fonts/AtkinsonHyperlegibleNext.woff2`, `fonts/AtkinsonHyperlegibleMono.woff2`, `fonts/SixtyfourConvergence-subset.woff2`, `fonts/OFL-*.txt`, `fonts/SOURCES.md` (upstream URL, commit, upstream sha256, fonttools and brotli versions, command, output sha256, axes, features, size), `core/LICENSE-pixelarticons.txt` (beside the `icons.ts` it licenses).
  - Delete: the Inter, Space Grotesk, JetBrains Mono and Material Symbols woff2 files (in phase 7, once nothing references them).
- **apps/tools:**
  - `app.css`, `public/theme-boot.js` (fallback colours), `public/favicon.svg`, `src/assets/token-sprite.svg`, `vite.config.ts` (`assetsInlineLimit` never inlines fonts).
  - The ~40 `.vue` style blocks and glyph call sites.
  - The uppercase literals from F6, plus `useCompletionToasts.ts`.
  - `AppShell.vue` (8×8 mark), `ThemeToggle.vue` (pixel icons plus a visible mode label; still one cycling control), `BridgePhaseRail.vue` (phase bar), `BridgeReceipt.vue` (split spans, convergence).
  - `send/AmountStep.vue` (veil line), `lib/send-model.ts` (`tokenRemainder` + a new `send-model.test.ts`).
  - `index.html` meta description.
  - `lib/errors.ts`, `lib/bridge-steps.ts`, `lib/capabilities.ts`, `AztecWalletPanel.vue`, `TokenCard.vue`, `send/SendWizard.vue`, `views/MainnetPlaceholderView.vue`, `ActivityView.vue`, `Footer.vue`, `DripView.vue` (both branches).
  - `constants/tokens.ts`, `contracts/deployments.{json,ts}`, `composables/useWalletConnection.ts`, `createAztecWalletSession.ts`, `useDrip.ts`.
  - `scripts/deploy-config.ts` (`TOOLS_DEPLOY_DATA_DIR`), `scripts/deploy.ts` (the type at `:103`), `scripts/verify-deployments.ts` (data-driven).
  - Add `contracts/deployment-records.ts`.
  - `tests/browser/test-wallet/{profile,main}.ts`, the listed tests, e2e fixtures and page objects.
  - `README.md`, `.env.example`.
  - Add `lib/wallet-name.ts` (+ test).
- **packages/bridge-core:** add `src/faucet-catalog.ts` (+ export); modify `scripts/sandbox/drip.ts`, `scripts/drip-canary-testnet.ts`, and the comment in `src/fee-juice.ts`.
- **implementations-plan/follow-ups.md:** add the mainnet SIGNAL/NOISE deploy and the decode motion.

### Non-obvious mechanics

- **Notch and focus.** The clip is on the `::before`, so the host's `:focus-visible` outline is intact. `isolation: isolate` keeps the `z-index: -1` fill inside the host. Hosts with popover descendants are never notched (F15).
- **Convergence hero.** `font-variation-settings` animates from `'XELA' 85, 'YELA' -70, 'SCAN' 70, 'BLED' 60` to zero over `--ul-converge` with `steps(8)`, once, when the arrived state mounts. The digits' text is real DOM; the animation only moves axes.
- **Phase bar.** It replaces `bar()`'s `▓░` text with a signal fill, a 3px ink front edge and a line-coloured remainder, using `role="progressbar"`. The `pulse`/`landed` classes keep their meaning; the `/▓+░+/` assertion moves to `aria-valuenow`.
- **Fonts never inline.** `build.assetsInlineLimit` is a function that returns `false` for `.woff2`. The build gate checks each target's `dist` for `data:font`.

### Trade-offs and alternatives not taken

| Alternative | Why not |
|---|---|
| One-shot codemod rename (the draft) | Semantically unsound: one old name has several roles. Expand–contract replaces it. |
| Values-only swap, keeping the old names forever (the competing outline) | Adopted as arc 1's first step (aliases). Rejected as the end state: the names lie about their role, and light-theme accent text needs a different token than fills. |
| Clip on the element | Clips focus rings. |
| `@fontsource` packages | Supply-chain dependencies for static files. |
| Radiogroup theme picker | Changes UX. |
| The bridge `promote` path | Needs the L1 bridge signer, and bridge and faucet are coupled there. |
| Token redeploy on an independent branch off `main` (Opus) | It touches the same files as the reskin (DripView, TokenCard, Footer, ActivityView), so it would conflict. With no owner gate left, stacking it last costs nothing. |

## Competing outline (audited): "values-first, single PR"

1. Keep all variable names and change only their values.
2. Clip the element itself, with inset-shadow focus.
3. Use `@fontsource` for the fonts.
4. Inline an SVG per component.
5. Ship it all as one PR.

**Audit outcome (both legs):** its values-first step is adopted as arc 1's alias layer. Everything else is rejected: clipped focus, npm supply chain for static files, duplicated SVG, and one unreviewable PR.

## Security & Adversarial Considerations

- **Threat model.** This is a static SPA on Cloudflare Workers talking to a user-chosen wallet. There are no new endpoints or network destinations. What changes:
  - (a) Wallet-supplied names are rendered in more places.
  - (b) Third-party font binaries and icon path data are vendored.
  - (c) A testnet deploy runs under the A4 identity.
  - (d) Branch pushes create public previews.
- **Wallet-supplied name: spoofing and bidi.**
  - `sanitizeWalletName` strips the `Cc`/`Cf` classes and the Hangul fillers, trims, then truncates. It runs at persistence, at display and on account aliases, and refreshes the stored name after a completed connect (F10). Output goes through Vue interpolation only; that prevents markup injection, but it does not prove a wallet's identity.
  - A hostile wallet can still name itself anything printable. Its name only appears inside prompts about that same wallet, which the user already chose. Accepted residual.
- **CSP.**
  - No new host. The static texture is a `data:` image, which `img-src` allows.
  - Fonts are never inlined, because `font-src 'self'` would block `data:font`.
  - The build gate diffs each target's `dist/_headers` against that target's baseline, taken from `main` before any change.
- **Supply chain.**
  - Fonts come from `google/fonts` and icons from Pixelarticons v2.4.0, each at a pinned commit or tag.
  - The **upstream** file sha256 is verified at vendoring time, before conversion. The upstream hash, tool versions, command and output hash are recorded in `SOURCES.md`.
  - A unit test recomputes output hashes to detect drift. This is a drift detector, not provenance.
  - Icon extraction takes only `d` attributes from path-only SVGs, keeping their order. The root `<svg>` may carry only `xmlns`, `width`, `height`, `fill` and `viewBox`. Any other element or attribute aborts the vendoring script.
  - No new npm dependency. fonttools runs as a local one-off, never in CI.
- **Deploy key.**
  - The deploying account gets no authority. The token constructor fixes the supplied Dripper as an immutable minter, and the Dripper's constructor is empty. This was confirmed by both audits.
  - Isolation: `--no-env-file`, alternate credentials and `AZTEC_NODE_URL` removed from the environment, and a mode-700 per-run PXE dir removed by a trap.
  - Option T's secret is never printed. Option K's key reaches only that one process, through `env-exec`.
- **Contract risks.**
  - Anyone can pre-deploy the identical universal instance. The address commits to the constructor args, so it carries the same minter.
  - The deploy script accepts an existing instance without re-checking it (F11). The both-token canary is what proves initialization and minting, before promotion.
  - The canary drips on the candidate before promotion, so a wrong record never reaches live.
  - The old faucet token contracts stay on testnet, unreferenced.
- **Previews.**
  - A branch is pushed only at an arc boundary, after that arc's quality loop has converged, so no half-reskinned arc is ever published.
  - Arc 3 is pushed only after phase 9's cutover, so no preview points at undeployed contracts.
  - Delaying a push is a release gate, not access control: once pushed, a preview is a public testnet app.
- **Privacy.** The veil is decoration; the private amount's rendering and handling are unchanged. No font or icon request leaves the origin.
- **Clickjacking.** `frame-ancestors 'none'` is unchanged.

## Phases

Each phase ends when its **validation gate** passes. Within a phase, run `bun run lint` plus the touched package's tests after every meaningful edit. Commit per step (conventional commits, signed). Do not push until the arc boundary (see Delivery).

**Phase gate (PG)**, run at the end of every phase:

```
bun run lint && bun run typecheck:all && bun run test:all && bun run --cwd apps/tools test:e2e
```

**Build gate (BG)**, run in phases 1, 7, 8, 9 and 10, and before every arc push. Each target is built, verified, scanned and diffed before the next build overwrites `dist`:

```
for t in testnet mainnet; do
  bun run --cwd apps/tools build:$t \
    && bun run --cwd apps/tools verify:build-target $t \
    && ! grep -rq 'data:font' apps/tools/dist \
    && diff "$SCRATCH/headers-$t" apps/tools/dist/_headers || exit 1
done
bun run --cwd apps/tools verify:deployments
```

**Pass criterion:** every command exits 0.
- `lint` covers Biome and the complexity baseline.
- `test:all` covers every `@unleashed/*` vitest suite.
- `test:e2e` is the jsdom smoke that CI runs.
- `$SCRATCH/headers-<target>` are copied from `main` builds before phase 1.

Glyph greps run with `LC_ALL=C.UTF-8`.

### Arc 1 — foundation (`packages/design` and global CSS)

#### Phase 1 — tokens (expand), contrast, fonts ✓
- **Before any change:** build each target from the untouched base and copy its `dist/_headers` to `$SCRATCH/headers-<target>`.
- **Tokens:**
  - Add the `--ul-*` set for dark and light (spec.md, with light ink-3 `#65636E`, `--ul-accent-text`, `--ul-on-signal`, `--ul-focus`).
  - Re-point every old name as an alias.
  - Keep the retired prefixes and names in `OWNED_PREFIXES`/`OWNED_EXACT`.
  - Rewrite `theme-contrast.ts` to the explicit pair list.
- **Fonts:**
  - Vendor the three fonts, with `SOURCES.md` and the hash test.
  - Re-point `--font-*` at them.
  - Set `assetsInlineLimit` so fonts never inline.
- **Gate:** PG + BG, plus `SOURCES.md` lists `tnum` among Next's features and four axes for Sixtyfour.

#### Phase 2 — primitives: notch, static, icon, motion ✓
- Add the `ul-notch`, `ul-veil` and `ul-scrim` utilities, `--ul-static`, the global focus-visible rule on `--ul-focus`, the motion tokens and the central reduced-motion rule.
- Add `scripts/vendor-icons.ts`, `core/icons.ts` and Icon.vue with its **API kept**, plus the explicit colour map.
- Tests:
  - `mount-all.test.ts` mounts Icon at 12, 16 and 24, including string `size="16"` and string `rotate`, and with `color`.
  - `vendor-icons.ts` aborts on any non-path element or non-`d` attribute (a unit test feeds it one).
  - An Icon unit test checks that `label` toggles `role="img"`/`aria-label` versus `aria-hidden`.
  - The existing `AccountSwitcher` and `AztecWalletPanel` tests stay green unchanged.
- **Gate:** PG. `boundary.test.ts` passes (no raw HTML).

#### Phase 3 — design primitives reskinned ✓
- Reskin Button (all variants), Card, Tag, Toast, Spinner (pixel loader), the EmojiGrid frame, AddressDisplay and BalanceRow.
- **Gate:** PG + BG, plus `git grep -nE 'text-transform:\s*uppercase|1px (solid|dashed)' -- 'packages/design/src/**/*.vue' packages/design/src/base.css` returns nothing.

**Arc 1 boundary:** codex loop (Post-implementation), then `gh stack push`, then `gh stack add <next-branch>`.

### Arc 2 — screens (`apps/tools`)

Each phase migrates its files' token references by role (text, fill, border or focus) off the aliases. It sentence-cases every literal in those files and updates the matching assertions from the recon inventory. Each such test edit is named in the commit body.

#### Phase 4 — shell ✓
- **Files:**
  - AppShell (8×8 mark), SectionHeader, RailNav (keeps `count`/`hot`), ThemeToggle.
  - DockStrip, ActivityDock (keeps `overlay`), ActivityRow (keeps `filled`/`dim`; the "✓" assertion moves to the icon label).
  - AccountSwitcher (**not** a notch host; `.menu` notched itself), L1WalletPanel, AztecWalletPanel (keeps `denied`), ConnectionErrorStrip, Footer (keeps `.contracts`), AppToastRegion, `useCompletionToasts.ts`.
  - `network.ts` `L1_CHAIN_LABEL`, `favicon.svg`.
- **Browser check:** open the account menu over the header and dock in both themes through the Playwright harness (screenshots to scratch), and confirm the menu paints above everything.
- **Gate:** PG.

#### Phase 5 — send wizard and veil line ✓
- **Files:**
  - WizardShell (keeps `sr-only`), StepStrip, TokenStep, TokenList (reverse video), TokenTile, MintStrip.
  - AmountStep (the amount wrapper is the notch host; block cursor; the private switch plus **the veil line**, A3/F20), ChoiceCards, GasBreakdown.
  - ReviewStep, ReviewDetails, SendWizard, SpriteSheet, `token-sprite.svg`.
  - `tokenRemainder` in `lib/send-model.ts`, adopted by GasBreakdown, ReviewStep and SendWizard.
- Dashed empty states become 4px-edge notes. `bridge-steps.ts` literals are sentence-cased.
- **Gate:** PG, plus:
  - `send-model.test.ts`: `tokenRemainder` returns `amount − fuelAmount`, 0 when the slice covers everything, and `amount` with no gas leg.
  - An AmountStep test: `l1-to-l2` with private on renders "you see {remainder} {symbol}" with the veil labelled "hidden amount"; private off, exit direction, and intent `gas` render no line.

#### Phase 6 — bridge progress, journal, receipt ✓
- **Files:**
  - BridgeStepper, BridgePhaseRail (phase bar; keeps its own pseudo-elements; `/▓+░+/` becomes an `aria-valuenow` assertion).
  - BridgeJournal, BridgeJournalCard (`stamp-in`/`flash` become a stepped tick; keeps `other`; "✓" moves to the icon label; `.toUpperCase()` removed).
  - BridgeReceipt (split spans, convergence, scanline; "NEW FUEL" becomes "New fuel"; its stale colour comment at `:129` is rewritten), BridgeFooter.
- **Gate:** PG.

#### Phase 7 — faucet, activity, modals, responsive and light pass, then contract ✓
- **Files:**
  - DripView (both branches), TokenCard, ActivityView (↗ and → become icons).
  - WalletPickerModal (`ul-scrim`; SDK name and icon; keeps `.name`), ChooseAccountModal.
  - VerificationModal (EmojiGrid frame; "Verify the grid"), MainnetPlaceholderView.
  - Playwright `accounts.spec.ts:109` becomes "Switch to", and `shell-smoke.test.ts:136` is updated.
- Pass over ≤1100 and ≤760 in both themes.
- **Contract:** delete the alias block from `base.css`, and delete the old font files.
- **Visual self-check (non-gating):** screenshot the board screens in both themes, compare each to its board, fix what reads differently, and note it in `lessons/phase-7.md`.
- **PR screenshots:** save the final set for the PR bodies. These are not baselines, and no test reads them.
- **Gate:** PG + BG (`theme-vars.test.ts` now fails on any leftover old reference), plus:
  - `git grep -nE 'text-transform:\s*uppercase|1px (solid|dashed)|letter-spacing:\s*0?\.[0-9]+em' -- 'apps/tools/src/**/*.vue' apps/tools/src/app.css` returns nothing.
  - `LC_ALL=C.UTF-8 git grep -nP '[✓✕⤓⤒⧉◆⚠↗▓░●▢]' -- 'apps/tools/src/**/*.vue' 'apps/tools/src/**/*.ts' ':!*.test.ts' | grep -vP '^[^:]+:\d+:\s*(//|\*|/\*|<!--)'` returns nothing. Comment lines are exempt; a multi-line comment that still carries a glyph gets rewritten.
  - `git grep -nE '^\s*color:\s*var\(--ul-signal\)' -- apps/tools/src packages/design/src` returns nothing. This is the accent-text guard; `background-color`/`border-color` stay allowed.
  - **`bun run e2e:tools`** (sandbox e2e plus Playwright, run-isolated, tears down only its own processes) exits 0.
- **Layers:** typecheck, lint, unit, jsdom smoke, both builds, sandbox e2e.

**Arc 2 boundary:** codex loop, then `gh stack push`, then `gh stack add <next-branch>`.

### Arc 3 — SIGNAL/NOISE and wallet copy

#### Phase 8 — faucet tooling, no cutover ✓
- **Add:** `packages/bridge-core/src/faucet-catalog.ts`, exported from `"."`, and `contracts/deployment-records.ts`. `deployments.ts` re-exports from the records module, so live consumers are unchanged.
- **Scripts:**
  - `verify-deployments.ts` and `drip-canary-testnet.ts` become data-driven over the given file's token records.
  - `deploy-config.ts` derives its token list from the catalog, and gains `TOOLS_DEPLOY_DATA_DIR`.
  - `deploy.ts:103`'s type follows the catalog.
- App consumers, the sandbox catalog and the live JSON stay on the old tokens.
- Run `bun --no-env-file apps/tools/scripts/deploy.ts --network testnet --dry-run` (no keys needed) and paste the SIGNAL/NOISE addresses into `lessons/phase-8.md`.
- **Gate:** PG + BG. `verify:deployments` must still pass on the old live file. A unit test must show the data-driven verifier failing on a record whose address was tampered with.

#### Phase 9 — testnet deploy and cutover (needs A4 and the runbook's Q2 authorization, quoted in lessons) ✓
1. Deploy with the isolation from Architecture §8 under the A4 identity. The output is `deployments.candidate.json`. Record its sha256.
2. Check that the candidate's addresses equal the phase-8 dry run.
3. Run `bun --no-env-file apps/tools/scripts/verify-deployments.ts --config apps/tools/src/contracts/deployments.candidate.json`.
4. Run `env -u AZTEC_NODE_URL bun --no-env-file packages/bridge-core/scripts/drip-canary-testnet.ts --config apps/tools/src/contracts/deployments.candidate.json`. It must drip both tokens.
5. Record both bridge manifests' sha256.
6. **Make the cutover commit:**
   - Copy the candidate over `deployments.json`.
   - Switch `deployments.ts` lookups, `constants/tokens.ts`, `sandbox/drip.ts`, `useWalletConnection.ts`, `useDrip.ts`, `DripView.vue`, `ActivityView.vue`, `Footer.vue`, `capabilities.ts`, `index.html`, README, `.env.example`, unit tests, e2e fixtures, page objects and browser specs to SIGNAL/NOISE.
7. **Check the byte pins:** live sha256 equals the candidate's; the Dripper record equals the old live one (`jq -S .dripper` on both); both bridge manifest hashes are unchanged.
- **Gate:** every step exits 0, plus PG + BG + `bun run e2e:tools` (the sandbox deploys SIGNAL/NOISE and the drip specs pass), plus a grep for the old token symbols across the apps and packages returns nothing.
- **Layers:** live testnet and sandbox e2e.

#### Phase 10 — wallet copy and wallet identity ✓
- **Sanitizer.** Add `lib/wallet-name.ts`, with tests covering:
  - U+202E, U+2066, U+200B, U+2060, U+00AD, U+FEFF, U+0000 and U+3164 stripped;
  - emoji not split by code-point truncation;
  - a name that is only invisible characters falling back to "your wallet".

  Wire it into the preferred-wallet read and write, `WalletPickerModal.displayName`, account aliases, and the reconnect name refresh (with a test).
- **Wallet copy.** Rewrite the 8 wallet-naming lines: the install CTA becomes generic; `errors.ts` and `bridge-steps.ts` take `walletLabel`; the toasts use it.
- **App copy.** The MainnetPlaceholderView link reads "Wallet site".
- Add the follow-ups (the mainnet deploy, decode) to `implementations-plan/follow-ups.md`.
- **Gate:** PG + BG, plus:
  - `bun run test:ci-gating` passes.
  - `bun run e2e:tools` exits 0.

## Decision ledger

| # | Decision | Chosen | Rejected and why | Source |
|---|---|---|---|---|
| D1 | Token migration | expand (aliases) → migrate by role → contract; retired prefixes stay owned | one-shot codemod: one name has several roles, and dropping prefixes blinds the ghost guard | Opus B4, Codex #8 |
| D2 | Notch | `::before` fill on leaf hosts only; popover hosts, inputs and BridgePhaseRail excluded | clip on the element: clips focus | spec; Opus I2, Codex #9 |
| D3 | Fonts | vendored woff2, upstream hash verified, tool versions recorded, never inlined | `@fontsource`; Google CDN (CSP, privacy) | recon; Codex #11, Opus |
| D4 | Theme control | the cycling button, restyled | radiogroup: UX change | user instruction |
| D5 | Decode motion | deferred to follow-ups | JS scramble plus aria-live on live values | planner |
| D6 | Faucet catalog | `bridge-core/src/faucet-catalog.ts` exported from `"."`, named `FAUCET_TOKENS` | the scripts path is not exported, and `./sandbox` is Node-only; the `DRIP_TOKENS` name is taken twice | Codex #10, Opus |
| D7 | Salts | 4246/4247 | reuse | recon |
| D8 | Wallet naming | sanitized SDK name, else "your wallet"; generic install CTA still linking to the Nulo store | hardcoded "Nulo"; no link | owner |
| D9 | Delivery | 3 stacked arcs, no owner gate | independent token branch: file overlap; one PR: unreviewable | Opus, planner |
| D10 | Visual gate | none; non-gating self-check; PR screenshots (repo rule) plus preview link; owner's written sign-off | screenshot baselines (declined) | owner; Codex #12; `AGENTS.md` |
| D11 | Deploy identity | **T**: a throwaway key under the owner's scoped written exception (A4), fully isolated | K = the owner's key via `env-exec` (complies with the rule, but exposes a valued key to an agent-driven process for no gain) | owner A4; Opus B2, Codex #2; final pass #3 |
| D12 | Promotion | faucet-only: candidate → data-driven verify → canary → one cutover commit (copy + consumers), with byte pins | `live-intent promote` (needs the L1 bridge signer; couples bridge and faucet); renaming consumers before the swap (module-load throw) | Opus B1, Codex #3; final pass #2 |
| D13 | Contrast | explicit permitted pairs, `accent-text` and `on-signal` roles, light ink-3 `#65636E` | TEXT × SURFACES product (fails by construction in light) | Opus B5, Codex #6 |
| D14 | Proof print | dropped | "proof" styling on decoration invites misuse as verification; not in spec | Opus |
| D15 | Mainnet faucet | testnet-only deploy; dormant mainnet copy renamed; mainnet deploy in follow-ups | mainnet deploy now: the build shows only a placeholder, and a mainnet deploy is a production action | Codex #1 (misread, but a valid follow-up) |
| D17 | Casing | sentence case everywhere, with inventoried assertion edits | CSS-only (mixed casing) | owner A2; Opus B3 |
| D19 | Gate cadence | PG every phase; BG per target at phases 1, 7–10 and every arc push | full build every phase (slow, and the single-dist FG failed by construction) | final pass #1 and sizing note |
| D20 | PR screenshots | embedded in PR bodies | owner uploads by hand (the CLI cannot attach images) | `AGENTS.md` |
| D18 | Veil line | add; `l1-to-l2` + private + remainder > 0 only; one extracted `tokenRemainder` | texture only; a fourth inline copy of the split | owner A3; F20 |

### Audit record — round 1 (both `reject`)

**Codex (GPT-6 Astra, high; session `01a0eae6-e1bd-7461-97ce-e605530f0730`):** `reject (with blocking findings: mainnet faucet regression, persisted deploy keys, incompatible promotion workflow, and invalid validation gates)`.
- **Accepted:**
  - #2 persisted keys → D11.
  - #3 promotion → D12.
  - #4 sanitizer → F10, `sanitizeWalletName`.
  - #5 gates → the grep fixes, `test:e2e` and both builds added.
  - #6 contrast → D13.
  - #7 recon overstatements → corrected in recon.md.
  - #8 codemod and Icon API → D1, Icon API kept.
  - #9 notch → D2.
  - #10 catalog → D6.
  - #11 supply chain and tnum → D3, F18.
  - #12 asks → owner answers; D10.
- **Rejected:** #1 as stated. The mainnet build renders only the placeholder (`App.vue:16`), so no mainnet faucet is live. It is kept as a follow-up (D15).

**Opus 5.5 (Plan subagent):** `reject (with blocking findings: B1–B6)`.
- **Accepted:**
  - B1 → D12.
  - B2 → D11.
  - B3 → the owner's A2 decision plus the inventory.
  - B4 → D1.
  - B5 → D13.
  - B6 → the gate fixes.
  - The sanitizer, randomart (D14), supply-chain provenance, `assetsInlineLimit`, `_headers` diff instead of exporting `cspFor`, previews and push timing, the refuted I1 (F8), I4 (F6), I2 popovers and inputs, `token-sprite` and `favicon`, the catalog location, the Icon API, the split receipt spans.
- **Rejected:** putting the token redeploy on an independent branch (D9): file overlap with arc 2, and no owner gate remains.

### Audit record — final fresh pass

**Codex (GPT-6 Astra, high; new session `01a0eaf9-b65b-7223-a227-0bbebe0d1a11`):** `reject (with blocking findings: broken fast gate, inconsistent token-cutover ordering, unsafe deployer environment selection, and incompatible icon extraction/API)`. No Critical finding. Every claim was verified in code or upstream before acting.
- **Accepted:**
  - #1 FG → D19, the per-target BG.
  - #2 cutover order → D12, phases 8–9 restructured.
  - #3 env selection → the isolation in §8.
  - #4 multi-path icons → F14, the vendoring rule.
  - #5 Icon prop types → F14, API and types kept, string-size test.
  - #6 interim contrast → the explicit alias table plus legacy pairs, `--ul-fill`/`--ul-notch` defaults, the map in Icon.vue.
  - #7 grep semantics → anchored `color:`, `<!--` exempt, `test:ci-gating`.
  - #8 sanitizer → the `Cc`/`Cf` class, trim, reconnect refresh, aliases.
  - #9 narrowed facts → F5, F8 (every connection re-consents once), F15.
  - The sizing note → PG/BG split.
- **Confirmed by the pass:** D11's premise (the deployer gets no authority), D12's copy approach, D9, D15, `.menu` notchable, `tokenRemainder` placement.
- **Disagreement, since resolved:** Codex first said no owner decision was needed. The repo's `AGENTS.md` rule "keys … are never created by an agent" makes deploy identity an owner decision (A4). Codex conceded this on resume.

**Confirmation (the same session, resumed):** `conditional approve (with conditions: clarify the T/K commands and cwd, generalize extracted record symbols, and resolve A4 before phase 9)`.
- #1, #2 and #4–#9 are resolved; #3 was partial.
- The BG loop was checked correct: the positional `mainnet` is accepted, and `build:mainnet` writes `apps/tools/dist`.
- A4, per Codex: T is stronger on least privilege; K complies without an exception. Its recommendation: "choose T only with a written, narrowly scoped exception; otherwise use K through the keyed-run process."
- Conditions 1–2 are applied in §8, including the root `<svg>` metadata allowance. Condition 3 goes to the owner at the approval gate.

## Approval

The owner answered "Approve" to: *"Do you approve plan v3.1 as shown in the ELI5 (scope, 3 stacked PRs, every user approving the new tokens once, screenshots committed to the plan folder)?"* This approves the visible surfaces listed under Scope, and those the ELI5's "What you will see change" table lists.

It is also the runbook's Q2 authorization for phase 9's scripted testnet deploy:
- The deploy reads **no** env files (`--no-env-file`).
- It creates exactly one credential, the throwaway key under A4's exception.
- Nothing is broadcast to mainnet, and nothing is broadcast to L1.

Per `AGENTS.md`, merging still needs the owner's written sign-off on each PR's screenshots.

## Post-implementation

`code_review` is `off`: `/code-review` is **not** run at any point in this plan.

**Multi-arc loop placement.** Steps 1–2 run **per arc at each arc boundary**: after the arc's last phase gate passes and **before** `gh stack add` opens the next arc, scoped to that arc's diff while it is the stack tip. After all three arcs are green and looped, run one **final cross-arc integration pass**. Then Delivery.

1. **Codex audit.**
   - Send `/codex high` (GPT-6 Astra):
     - the arc's diff (`git diff <arc-base>...HEAD`);
     - this plan.md with its decision ledger;
     - the arc map: "arc N of 3. Arc 1 = design foundation (tokens with old names aliased, fonts, primitives); arc 2 = app screens migrated off the aliases onto the primitives, then aliases deleted; arc 3 = SIGNAL/NOISE redeploy + wallet copy. Primitives that look unused in arc 1 are consumed in arc 2."
   - Ask for adversarial and security review: what could an attacker target, what are we trusting that we shouldn't, and where are the supply-chain, CSP and least-privilege weaknesses?
   - Include verbatim: *"Report bugs and small, targeted improvements only. Do not propose speculative abstractions, extra configuration surface, new layers, or rewrites — the smallest change that fixes each real problem. If code works and is clear, leave it alone."*
   - Include verbatim: *"Audit the comments for value per character. Flag any comment that narrates what the code visibly does, restates its line, references implementation plans / phases / reviews, or spends a paragraph where a sentence works — and flag places where a non-obvious invariant or constraint deserves a comment it doesn't have. Comments are permanent context every future reader, human or LLM, pays to re-read: they must be few, dense, and exact."*
2. **Iterative fix loop.**
   - Verify each finding's factual claims against the repo before acting.
   - Apply the accepted fixes, commit them separately, and log the round (consult plus verdict, accepted and rejected with reasons) in `lessons/phase-N.md`.
   - **Resume the same codex session** with the fix diff and ask it to re-review under the same two rules.
   - Repeat until a round yields no new material findings (rejected nitpicks don't count). Still producing material findings after 3 rounds? Stop and surface it to the owner.
3. **Final cross-arc integration pass.** A **fresh** codex session (`/codex high`) over the net diff from `main`, asking explicitly for cross-arc issues: seams between arcs, duplication across arcs, drift from this plan, and any token, icon, glyph or uppercase literal left over. Include the same two verbatim rules. Run the same loop until clean.
4. **Delivery** per the section below. This is the first time any PR is opened.

## Delivery

| Arc | Branch | Phases | Stacks on | `/code-review` |
|---|---|---|---|---|
| 1 foundation | the task branch (adopted as layer 1) | 1–3 | `main` | off |
| 2 screens | arc 2's branch | 4–7 | arc 1 | off |
| 3 tokens + copy | arc 3's branch | 8–10 | arc 2 | off |

**Mechanics:**
- **Start:** `gh stack init --adopt` on the task branch (confirm the extension with `gh extension list`; if it's missing, `gh extension install github/gh-stack`).
- **Pushes:** a branch is pushed only at its arc boundary, after its codex loop has converged. A push creates a public testnet preview, so no half-arc is ever published.
- **Arc boundary:** `gh stack push`, then `gh stack add <next-branch>`.
- **Delivery:**
  1. After arc 3's loop and the cross-arc pass converge, run `bun run audit:tools` and `bun run test:all` (repo rule), then `gh stack sync`.
  2. Run `gh stack submit --auto`.
  3. Run `gh pr edit` for each PR to write a real body: what changed, the visible surfaces, the embedded screenshots, the assertion edits by file, and the preview URL. PR 3's body adds the deployed addresses, the canary output and the byte pins. Titles are lower-case conventional commits of 93 characters at most.
  4. Run `gh pr checks --watch`.
- **Arc 2 sizing:** if arc 2's diff exceeds one sitting, split it at phase 5/6 into two branches before submitting.
- **Merging** (`gh stack merge`) and the production deploy it triggers (Workers Builds) are the owner's call, after their written UI sign-off. Never do them autonomously or while AFK.

**Post-implementation hardening:** `/harden` is not scheduled. The change adds no trust boundary, auth, secret custody or CI surface.

## Seeds

*Final (approved).*

**`/goal` (recommended):** completion is transcript-observable, and it survives `claude --resume`.

```
/goal All ten phases in implementations-plan/unleashed-reskin/plan.md are marked ✓ in plan.md itself (not the chat, not the task list), each ✓ backed by that phase's validation gate, as written in plan.md, reported passing in the transcript; for each phase the agent has printed LESSONS_FILE=implementations-plan/unleashed-reskin/lessons/phase-N.md in the transcript; phase 9's gate output shows the SIGNAL/NOISE addresses equal the dry run, the canary dripped both tokens, and both bridge manifest sha256 values unchanged; /code-review was NOT run (plan.md code_review: off); the codex fix loop converged at each of the three arc boundaries and in the final fresh cross-arc pass, each shown by a codex pass reporting no new material findings, quoted in the transcript; the three stacked PRs exist on GitHub, created only after every loop converged (gh stack view output in the transcript), each with a real body and with gh pr checks green; bun run typecheck:all, bun run lint, bun run test:all, bun run audit:tools and bun run e2e:tools each report exit 0 in the transcript; each PR body embeds the screenshots. Never merge, never deploy to production or mainnet, never push a branch except at its arc boundary.
```

**`/loop 15m` (fallback).** Use exactly one per session; they don't compose.

```
/loop 15m Drive implementations-plan/unleashed-reskin forward. Never idle waiting for my input. Each firing:
1. Reality check: read implementations-plan/unleashed-reskin/plan.md (including Outcome & Quality Bar; every step is judged against it) and lessons/. If that path is gone, or plan.md carries an "## Outcome" block, the plan is closed: STOP. If the task list is empty, rebuild it from plan.md, one task per remaining step. Run git status and git log --oneline -5; if PRs exist, gh stack view and gh pr view --json statusCheckRollup (no --watch).
2. Waiting on CI is fine: confirm it progresses (gh run watch up to 10 minutes; stuck past that → log it as blocked in lessons). Use the wait to review the diff or prep the next phase.
3. No task in hand? Take the next pending step in plan.md. After each meaningful edit run bun run lint plus the touched package's tests. Commit (signed; conventional). Do NOT push mid-arc: a push publishes a public preview.
4. Stuck, or facing a decision you would bring to me? Call /codex high with full context and settle it together, then act. Log every consult and verdict in lessons/phase-N.md. Hard limits stay hard: never merge, never deploy to production or mainnet, never touch, print or ask for keys (phase 9 runs only as plan.md §8 option T: a throwaway key generated in the deploy's own shell under the owner's A4 exception, never printed, with the isolation in §8; copy the Approval section's Q2 authorization into lessons/phase-9.md first), never expand scope beyond plan.md; if a decision needs one of those, surface it and hold.
5. Same step failed 5 times? Stop retrying; reassess with codex, then continue on the agreed path.
6. Phase green means its validation gate in plan.md passes exactly as written. Paste the result, mark ✓ in plan.md, write the lessons entry, print LESSONS_FILE=implementations-plan/unleashed-reskin/lessons/phase-N.md, move on. At an arc boundary (after phases 3, 7 and 10): /code-review is off, so run the /codex high loop on the arc diff with the arc map and plan.md's two verbatim rules until a round has nothing material (3 rounds max, then surface). Then gh stack push and, for arcs 1–2, gh stack add the next branch.
7. All phases ✓? Run the final FRESH /codex high cross-arc pass over the net diff from main until clean. Then Delivery per plan.md: bun run audit:tools and bun run test:all, gh stack sync, gh stack submit --auto, gh pr edit each body (changes, visible surfaces, screenshots, assertion edits, preview URL; for PR 3 the addresses, canary output and byte pins), gh pr checks --watch. Then write the wrap-up (what shipped, each contested decision with plain-language context, open items). Surface and stop.
Keep the task list current with TaskUpdate; plan.md stays the source of truth.
```
