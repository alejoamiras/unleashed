# Phase 13 — One number display rule

## What was done

- **Formatter.** `lib/format.ts` gains `formatDisplayAmount(value, decimals)`. The whole part comes from `toLocaleString("en-US")`. The fraction is the full fraction with trailing zeros stripped, padded to `min(2, decimals)`. A value with 0 decimals gets no fraction. Nothing is cut or rounded, so `0.005` stays `0.005`.
- **Display sites (G38, OQ3 A).** These sites now call `formatDisplayAmount` instead of `toDecimalString`:
  - `BridgeReceipt.vue`: the hero `amountDisplay`.
  - `ReviewStep.vue`: `sendAmount` and the token part of `tokenArrives`.
  - `AmountStep.vue`: the veil line and `balanceText`.
  - `GasBreakdown.vue`: `tokenArrives` and `sliceText`.
  - `SendWizard.vue`: the step-rail `amountLabel` and `promisedLine`.

  `onUseAll` still types `toDecimalString`, so "use all" fills the field with an ungrouped exact number. `formatCompact` stays on every "≈" quote. `SendWizard.vue` and `GasBreakdown.vue` no longer import `toDecimalString`.
- **Comments.** `AmountStep.vue`'s balance comment now says the line is exact and never cut, and that `onUseAll` fills the field with the same number, ungrouped. `BridgeReceipt.vue`'s comment above `amountDisplay` now says "exact and grouped like the review's own figures".
- **Receipt fit.** The hero's `--n` is `amountDisplay.length`, so it already counts the new commas. No code change was needed there.

## Tests

- `format.test.ts`: one `it.each` table with the plan's seven rows (`250.00`, `1,000.00`, `0.005`, `0.000000000000000001`, `0.00`, `1,000`, `12.5`).
- Pins moved to the padded form (the commit message names them):
  - `BridgeReceipt.test.ts`: `100.00 TOKEN` ×2, `40.00 TOKEN`, `20.00 Private FJ`, `12.50 FJ`, and `1.50 WBTC` in the hero, the review-said fixture and "you got".
  - `AmountStep.test.ts`: `3.00 USDC` in the breakdown and "you see 3.00 USDC".
  - `GasBreakdown.test.ts`: `8.00 USDC`, "from 2.00 USDC", `0.00 USDC`, `10.00 USDC`.
  - `ReviewStep.test.ts`: `10.00 USDC` ×2 and `8.00 USDC`.
  - `SendWizard.test.ts`: `reviewSaid` "1.00 WBTC".
- The pins that must not move still hold: "Balance 0.005 USDC" (`AmountStep.test.ts`), the `0.005 USDC` receipt and review pins, and the `toDecimalString` round trip.
- No e2e change. I grepped `tests/browser` and `tests/e2e`: every receipt-hero read is a `toContain` ("10", "USDT", "FJ", "FRSHR"), and the only balance read is `toContainText(/\d/)`.

## Attempts and notes

1. The first unit run after the swap failed 13 tests, more than the plan's pin list. The plan cites only the first failing line of each test. Some cases were not listed at all: the fuel receipts (`20 Private FJ`, `12.5 FJ`), the withdraw and no-fuel receipts, and the second and third assertions inside each listed test. The plan's `SendWizard.test.ts:1376` is at `:1387` on this branch. After I moved all 13 to the padded form, 1544 of 1544 passed.
2. `GasBreakdown.test.ts`'s `toContain("0 USDC")` still passed against "0.00 USDC", because it matches the text as a substring. I tightened it to `0.00 USDC` so it pins the rule.
3. The first `bun run lint` failed on Biome's formatting of the grown import line in `format.test.ts`. `biome format --write` fixed it. The Biome warning and the two infos come from files this phase did not touch.

## Deviations from the plan

- **Pin set.** I updated more test pins than the plan listed (see attempt 1). Every one is the same `N` → `N.00` rewrite that OQ3 A asks for. No assertion was weakened, and one was tightened.
- **Mixed figures on the receipt until phase 14–15.** The receipt's gas figures (`availableDisplay`, the dead `usedDisplay`) still use `toDecimalString`, as the gate expects. Until phase 15 rewrites that row, a token + gas receipt reads e.g. "you got 1.50 WBTC + 5 Private FJ": the token amount is padded and the gas figure is not.

## Validation gate

Run (the display-site swap):
- `bun run lint` exit 0 (Biome: 1 warning and 2 infos, none in files this phase touched; complexity-baseline check OK).
- `bun run typecheck:all` exit 0.
- `bun run test:all` exit 0 (design 236 in 21 files; bridge-core 447 + 1 skipped in 50 files; tools 1544 in 106 files).
- `bun run --cwd apps/tools test:e2e` exit 0 (30 tests in 3 files).
- `git grep -n 'toDecimalString(' -- 'apps/tools/src/**/*.vue'` prints exactly three lines: `BridgeReceipt.vue:73` (`usedDisplay`), `BridgeReceipt.vue:79` (`availableDisplay`) and `AmountStep.vue:147` (`onUseAll`).
- Baseline: `git diff --exit-code <rev> -- scripts/complexity-baseline/manifest.json` exit 0.

## Flags for owner sign-off

- These are copy changes to visible numbers, decided by OQ3 A. They are checked in arc 5's tour, not in this phase (no T in this gate). They cover the review, the amount step's balance line and veil, the gas breakdown, the step-rail amount value, the background strip's promised line, and the receipt hero.
- This phase also pads the fuel receipt hero ("12.50 FJ"). Phase 14's R5-1 change replaces what a gas-only hero shows.
