# Phase 4 — shell

## Result
Gate passed.
- **PG:** lint, typecheck:all, test:all and the jsdom smoke all pass.
- **Browser check:** a scratch Playwright spec (deleted afterwards) connected both wallets and opened the account menu in dark and light.
  - At 1440 × 900 the menu is the element under its own lower edge, so it paints above the header and the dock, and it lies inside the viewport.
  - At 390 × 844 the menu fits and `scrollWidth` is at most 390.

## What changed
- **Shell:** the rail is a well with the 8×8 mark and the `unleashed` wordmark.
  - The current section is reverse video (ink fill), and entries carry pixel icons.
  - The count stays neutral in both states: it is a count, not a call.
  - There is no header divider, and the dock strip is a well too.
- **Chips:** Ethereum and Aztec share one recipe: raised, px2, 48px tall, a carrier dot, a label over a Mono address. The menu is its own px4 raised surface; the switcher is not a notch host.
- **ActivityRow and ActivityDock:** sentence-case actions, "Bridged" with a check icon, and "Hide" with a chevron. The phase word is capitalised at display, so the stored phase stays lower-case.
- **Other surfaces:**
  - The error strip is a lost-bg px4 fill with a labelled `square-alert` icon.
  - The footer loses its rule and its links get dotted underlines.
  - The theme control remains one cycling button, now with pixel moon, sun and monitor icons.
- **Toasts** keep the spec's panel and 4px edge rather than the board's raised fill with no edge, and their enter/leave transition is stepped on `--ul-tune`.
- **Material Symbols** is gone (font file, `@font-face`, the utility class and the `LEGACY` allowance in `fonts.test.ts`). The shell was its last consumer, so it left here rather than in phase 7.
- `L1_CHAIN_LABEL` is sentence-cased. Nothing outside its test reads it, but it is a user-facing literal.

## Decisions from the browser check
- **Account menu anchor.** The restyled chip is narrower, so a left-anchored menu ran 14px past the right edge at 1440. It now hangs from the chip's right edge on desktop and from its left at ≤760, where the chips stack at the left.
- **Phone rail.** At 390 the one-row rail measured 482px. It now wraps into the DCQMobile board's two rows: brand and theme first, then full-width tabs. Only CSS changed (`order`, `flex-wrap`); the DOM and the tab order did not. The visual order puts the theme button before the tabs, while focus reaches the tabs first. The PR screenshots carry this for the owner's sign-off.
- **The wordmark renders red.** Sixtyfour Convergence is a COLRv1 font whose CPAL palettes are fixed red/green/blue layers composited with SCREEN, so `color` has no effect. Axes at 0 change nothing visible at 12px. The canvas used the same font, so this is the approved look. `font-palette: dark` would select palette 1 (flagged for dark backgrounds) if the owner ever wants it.

## Test and copy edits (sentence case)
- `ActivityRow.test.ts`: CLAIM/FINISH/RETRY/CLAIM GAS/CLAIMING… → sentence case; "crossing"/"blocked" → "Crossing"/"Blocked"; "Bridged ✓" → "Bridged" plus an assertion that the side's icon is `check`.
- `ActivityDock.test.ts`: CLAIMING…/CLAIM GAS → "Claiming…"/"Claim gas".
- `network.test.ts`: "ETHEREUM · SEPOLIA"/"ETHEREUM" → "Ethereum · Sepolia"/"Ethereum".
- `tests/e2e/shell-smoke.test.ts`: the completion toast no longer ends in "✓"; the dock's action reads "Claim".
- `fonts.test.ts`: the Material Symbols exemption is removed with the file.

## Attempts
- **e2e:tools could not boot the sandbox.** This worktree lacked `contracts/bridge/evm/lib`. The pinned `forge install` (the commits in `_tools-e2e.yml`) needs `--no-git` inside a worktree, or it registers submodules in the index.
