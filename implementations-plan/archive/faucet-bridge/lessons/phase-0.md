# Phase 0 — `@unleashed/design` extraction

**Status:** ✓ done (10/10 components — EmojiGrid + BalanceRow decoupled in the followup below). All gates green.

## What shipped
- New `packages/design` (`@unleashed/design`): `package.json` (exports `.` / `./tokens` / `./base.css` / `./ui/*` / `./composite/*`), `tsconfig.json`, `vitest.config.ts`, `src/index.ts` barrel.
- Moved (with history): `tokens.ts` + `base.css` + 8 components (5 ui: AppButton, Card, Spinner, Tag, Toast · 3 composite: AddressDisplay, DripButton, DisclaimerTag) + their 8 colocated tests.
- Faucet rewired: `main.ts` → `@unleashed/design/base.css`; consumers (WalletPanel, AppToastRegion, TokenCard, VerificationModal) → barrel imports from `@unleashed/design`. Added `@unleashed/design: workspace:*` dep.
- `biome.json`: new override — `packages/design/src/**` bans imports of the other workspace packages (lowest layer) + `chrome.*`.

## Gates (all green)
- lint 0 errors · design tests 8 files/51 · faucet tests 16 files/143 · faucet `vite build` ✓ · design + faucet `vue-tsc` ✓.

## Lessons / decisions
1. **`.vue` from a workspace package builds fine.** The open risk (vite compiling `.vue` re-exported from a linked `@unleashed/design`) is a non-issue: the barrel `export { default as X } from "./ui/X.vue"` + faucet `import { X } from "@unleashed/design"` compiles through vite 8 (rolldown) and `vue-tsc` resolves it via the exports map. No `optimizeDeps`/dedupe tweak needed.
2. **biome line-width.** A `noRestrictedImports` rule with a long message exceeds the 140-col width → biome wants it multi-line. `bun run lint:fix biome.json` formats just that file.
3. **DEFERRED: `EmojiGrid` + `BalanceRow`.** The research called these "already-decoupled" but they import faucet-app-specific `@/lib/{emoji,format,testids}` and hardcode `TESTIDS.*` in their templates. Those utils are used broadly across the faucet (App.vue, WalletPanel, composables…), so they're app-owned, not design-owned. Moving these two cleanly requires **prop-decoupling**: `testId` as a prop (components must not hardcode app e2e selectors — matches CLAUDE.md's testid rule), and the parent passes the formatted value / emoji grid. That's a deliberate API refactor (ripples to TokenCard, VerificationModal + the two tests) better done on its own. **Follow-up:** "P0-followup: decouple EmojiGrid + BalanceRow into @unleashed/design (testid + value props; preserve testid values verbatim)." Tracked in plan.md.
4. **Fonts stay consumer-owned.** `base.css` references `/fonts/*.woff2` (absolute); the faucet still serves them from its `public/fonts/`. No change needed; documented in `@unleashed/design/src/index.ts`.

## P0-followup — decouple EmojiGrid + BalanceRow (✓ done)
- Made both **presentational**: `EmojiGrid` takes `cells: string[]` + `testId?` + `cellTestId?: (i)=>string`; `BalanceRow` takes `publicText`/`privateText` + `publicTestId?`/`privateTestId?`. No `@/lib` imports remain.
- Logic moved UP to consumers: `VerificationModal` runs `toGrid(emojis)` + passes `TESTIDS.emojiGrid`/`TESTIDS.emojiCell`; `TokenCard` runs `formatBigInt` + the null/loading render + passes `TESTIDS.balancePublic`/`balancePrivate`. **Testid VALUES preserved verbatim** (e2e selectors intact) — they're now passed by the parent instead of hardcoded in the shared component.
- Tests rewritten for the presentational API with **literal** testids (no `@/lib/testids` dependency). Numeric-format edge cases now covered by `lib/format.test.ts` (formatBigInt) rather than duplicated in the component test — testing the logic where it lives (succinctness).
- Gates: lint 0 errors · design 10 files/66 tests · faucet 14 files/123 tests · faucet build + both typechecks green.
