# Phase 26 — Wizard head and wallet chips

## What was done

- **Wizard head, G18.** `WizardShell.vue` reads `useMediaQuery(PHONE_QUERY)` and hands `StepStrip` `orientation="horizontal"` at ≤760 (vertical otherwise). Its ≤760 head is a column (gap 10, padding 12 12 0), `.position` is `display: none` (the live caption still announces the step, and `WizardShell.test.ts` still reads `.position` from the DOM), the strip gets `padding: 10px 12px 0` and the panel `16px 12px`, matching the Mobile board's head and body insets.
- `DirectionSegment.vue` ≤760: `.segment { flex: none }` (in a column head the 428px basis would be a height) and `.seg { min-height: 36px; padding: 0 8px; white-space: nowrap }`. The in-flight stepper's locked row keeps its own `flex: 0 1 380px`, because its selector is more specific, so it spans the row on phones as before. It also takes the 36px one-line buttons, as the board draws them.
- `StepStrip.vue` horizontal: a done step that shows its value carries `data-valued`. Cells are left-aligned with `min-width: 0`, so a long value or label ellipsizes while the tab's `aria-label` keeps the full name. Markers are 800 11. Done cells are raised with the 12px check and the value in Mono 13, active cells are signal-tint, and todo cells keep ink-2 text with an ink-3 marker inside the 2px line inset. These rules existed before this phase and are unchanged.
- **Wallet chips, G69, OQ13 A.** `SectionHeader.vue` ≤760 `.wallets` is a column: children stretch, gap 6. `L1WalletPanel.vue` ≤760: the chip is a 44px wrapping row (padding 6 2 6 14, gap 8 12). The identity is one row, and the 13px label flexes, which pushes the address right. `.wrong-chain` has `order: 1` and `flex-basis: 100%`, and Connect is `width: 100%`. The × keeps its 32px target, so the right inset is 2px and the glyph lands 12px from the edge, where the Aztec chevron does. `AccountSwitcher.vue` ≤760: the chip is `flex: 1`, 44px tall, with a row identity and the 13px label flexing. `AztecWalletPanel.vue` ≤760: `.cta` is `width: 100%`, and the split connect is a flex row with a flexing `.cta`. CSS only; no testid changed.

## Tests

- `WizardShell.test.ts`: the existing desktop case still pins `orientation="vertical"`. A new phone case stubs `matchMedia` and expects `horizontal`.
- `StepStrip.test.ts`: one horizontal case. A done step with a value has `data-valued` and a 12px check svg; a done step without a value has no `data-valued`.
- Chip CSS is proved by layout, not jsdom (see below and the gate).

## Attempts and notes

1. **A throwaway layout check (`zz-p26.spec.ts`, deleted before the gate, never committed).** It ran at 390 in dark and light, with 1440 for regression. It measured:
   - Disconnected: both Connect buttons at x 16–374, 48 tall.
   - Connected: the L1 chip and the Aztec chip at x 16–374, 44 tall, 6px apart (y 195.6 and 245.6).
   - Direction tabs: 161×36 each inside the card (x 32–358).
   - Step cells: three at 108.7×36 (x 28–362).
   - `.position` hidden.
   - Cells on the amount step: `done valued=true "Token: USDC"`, `active "Amount"`, `todo "Review"`.
   - Wrong chain (`l1.setChainId(1)`): the L1 chip grows to 80 tall, with "Switch to …" on its own full-width second line (x 30–360) and the × still on line 1.
   - The account menu hangs from the chip's left edge.
   - The page never scrolls sideways (scrollWidth 390).
   - The 1440 captures are unchanged: head row, vertical rail, "Step 2 of 3", inline chips with the wrong-chain switch inline.
2. No code failures in this phase.

## Deviations

- **Panel padding at ≤760** went from `6px 12px 16px` to `16px 12px`, and the strip got `10px 12px 0`. The phase names only the head rules, but the strip now sits in the body above the panel, and these insets reproduce the board's head (padding 12 12 0, gap 10) and body (padding 16 12). Nothing changes above 760.
- `data-valued` is a state hook (tests, styling). The value's Mono 13 face comes from the existing `.value` rule, which renders only on valued cells.

## Validation gate

- **PG:**
  - `bun run lint` exit 0 (the known warning and two infos; complexity-baseline OK)
  - `bun run typecheck:all` exit 0
  - `bun run test:all` exit 0: design 242, bridge-core 451 + 1 skipped, tools 1612
  - `bun run --cwd apps/tools test:e2e` exit 0 (30)
  - `git diff --exit-code <rev> -- scripts/complexity-baseline/manifest.json packages/bridge-core` exit 0
- **Browser:** `agent.sh specs/spike.spec.ts specs/accounts.spec.ts specs/l1-wallet.spec.ts` exit 0, **17 passed** (17.9m), with no retries or flakes. This includes spike's 390 phone case, which connects and deposits through the stacked chips, and l1-wallet's wrong-chain case at 1440.

## Board comparison (Mobile board, 390; not a tour, for the record)

1. **Ethereum chip trailing control:** the board draws a chevron; the app keeps the × (OQ13 A, a decision).
2. **Amount step body** (the "What arrives" heading, one-line rows with hints, the Amount label row, full-width Continue over Back) is phase 27; unchanged here.
3. **Theme control and header perforation:** the differences already recorded in phase 25 remain.
4. The rail chip's 22px magenta count was not visible, because the check had no needs-you record (same as phase 25).

## Flags for owner sign-off

- The wrong-chain chip on phones grows to two lines (80px), with "Switch to …" full width inside the chip. The board draws no wrong-chain state.
- The L1 × keeps a 32px touch target with a 2px right inset. Its glyph lands 12px from the chip's edge, as the board's chevron does, but the address sits about 22px from the glyph, not the board's 12.

## Verifier round 1

Fix, CSS only, all at ≤760 (the wrap rule is ≤340).

**Accepted:**

1. **(medium) Long alias overflows the page sideways.** Confirmed against the code. `.identity` already had `min-width: 0`, and `.net` gets a zero automatic minimum from `overflow: hidden`. But the flexing `.chip` kept its content-sized automatic minimum, so a long alias widened it past the viewport. This phase introduced the regression when it dropped the 22ch cap. Fix: `.chip { min-width: 0 }`.
2. **(low) Direction labels spill at 320.** Accepted, because the fix is one rule and brings back the wrapping these labels had before this phase. Below 340, `.seg` is `white-space: normal`. From 341 to 760 the labels stay on one line, as the board draws them.
3. **(low) Transient connect states render at content width.** Accepted. The connect button morphs in place, so a width jump in the middle of a connect is a defect. Fix: `.morph { align-items: stretch }`. This is a visible change on phones, so it is flagged below.

**Rejected:** none.

**Check:** a throwaway `zz-p26v.spec.ts`, deleted before the gate and never committed.
- Aztec chip with a 57-character alias injected into `.net`: the chip's right edge is 374 at 390 wide and 344 at 360 wide, scrollWidth is 390 and 360, and the label ellipsizes.
- Wizard direction tabs: 161×36 on one line at 390, 146×36 at 360. At 320 each tab is 126 wide and wraps to two lines inside its 36px height, with no overflow (scrollWidth = clientWidth).
- An injected `.morph` button inside the Aztec panel at 390 is 358 wide, the same as the panel and the Connect button.
- The in-flight stepper's locked row at 320 was not driven, because the check had no running send. It takes the same `.seg` wrap rule.

**Flag for owner sign-off:** on phones, "Setting up session", "Approve in your wallet" and "Permissions denied — try again" now fill the width, like the Connect button they replace. Surface 4 names only the Connect buttons.

**Gate:**
- **PG:** `bun run lint`, `bun run typecheck:all` and `bun run test:all` all exit 0 (design 242, bridge-core 451 + 1 skipped, tools 1612). `bun run --cwd apps/tools test:e2e` exits 0 (30). The baseline diff exits 0.
- **Browser:** `agent.sh specs/spike.spec.ts specs/accounts.spec.ts specs/l1-wallet.spec.ts` exits 0 with **17 passed** (17.7m) and no flakes.
