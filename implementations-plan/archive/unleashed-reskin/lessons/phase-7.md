# Phase 7 — faucet, activity, modals, responsive and light pass, then contract

## Result
Gate: see the bottom of this file.

The PR screenshot set was taken by a throwaway Playwright tour (deleted before commit) at 1440 and 390 in both themes.

## What changed
- **Faucet.**
  - The DripView intro is Next at 16px in ink-2.
  - TokenCard:
    - The symbol is Mono 700 at 24px. "Fixed drip:" is followed by the amount and symbol in bold Mono; the text content is unchanged.
    - Add to wallet is a small quiet `Button` that shows the loader while it submits. Its "Added ✓" became a `check` icon plus "Added".
    - The status row is a notched strip whose fill carries the outcome: well while dripping, carrier-bg for a fresh success (with a `check`), lost-bg for a fresh failure.
    - "view tx →" became "View tx" plus `external-link`, in accent bold. The drip toast's link label reads "View tx", and so does the completion toast's.
- **Activity.**
  - The unavailable placeholder, on both Activity and Send, is a notched well.
  - The first-visit block: "First time here" is an accent eyebrow. The two verb tiles are raised and notched; the primary tile has a 4px signal edge, and each tile has an `arrow-right` icon. The tiles stack at ≤760.
- **Modals.**
  - All three sit on `.ul-scrim` (void plus static) as px6 panels.
  - Titles read "Choose a wallet", "Choose main account" and "Verify the grid", at 20px/700.
  - Wallet picker:
    - The collision warning is an attention-bg strip with `warning-diamond`; the ⚠ glyph is gone.
    - Rows are raised and notched. The wallet type is a `Tag`.
    - A wallet without a trustworthy icon gets an empty well tile, not ◆. A glyph there could pass for a brand mark.
    - The scanning dot pulses in steps.
  - Account chooser: rows are raised, and the pick is reverse video with a `check` icon (the ✓ glyph is gone). The truncation note uses the other colour.
  - The emoji grid frame was already reskinned with the design primitives.
- **Mainnet placeholder.** The h1 is sentence case at 44px (32px at ≤760). Links are accent with a dotted underline and `external-link`.
- **Contract.**
  - The alias block is deleted from `base.css`, in the dark root and in the light block. `body` reads `--ul-font-body`, and `app.css` reads `--ul-bg`/`--ul-ink`.
  - `--txt-white` found its home as `--ul-on-mark` (#fbf9f3 in both themes): text on a token's hue mark, which stays mid-dark (HSL lightness 32–42%) in either theme. TokenTile, TokenStep and `Icon`'s `white` colour read it; `Icon`'s `inverse` reads `--ul-bg`.
  - `theme-contrast.test.ts` lost its legacy pairs. Its alias test now checks that a token reference (`--ul-on-signal`) follows the theme of the token it names.
  - The old font files were already deleted in phases 1 and 4; nothing was left to remove.
- **One `.sr-only`.** It now lives in `base.css`; the copies in ChoiceCards and WizardShell are gone. The class name is kept because `WizardShell.test.ts` selects on it.

## Board comparison
The ten A′ screen boards were rendered from the canvas source and set beside the app.
- **Journal cards.** The compact rail is now one segment per phase with its label under it, as on the board, instead of the glyph strip.
  - Segment colours: done carrier, live signal, failed lost, pending line. A card that needs the user turns its live segment attention.
  - The live segment carries its clock.
  - Each cell is `role="img"`, labelled "{phase}, {state}".
  - At ≤760 only the live (or failed) label shows, and that cell takes four shares of the width.
- **Journal header.** The amount is bold Mono and the direction drops to ink-2 at 13px. The order is unchanged.
- **Tx links** (journal, receipt, faucet) are accent 700 in Next with the `external-link` icon, as on the boards.
- **Receipt.** It now sits in its own notched panel (px4), like the stepper, and the carrier check moved beside the hero label.
- **Footers.** The boards differ. On the bridge, links are ink-2 with a dotted underline; on the faucet they are accent with a dotted underline. Each footer follows its own board.
- **Faucet balances.** `BalanceRow` drops its dotted section rules. Each balance now sits in its own notched well (px2), as on the faucet board.
- **Faucet actions.** `DripButton` takes a `variant` prop, which defaults to secondary. The private drip is primary, as on the board, and the public drip stays secondary.
- **Modal widths** follow the boards: the wallet picker is 480px and the account chooser 440px.
- **Left as they are (layout, not look):**
  - The board's in-flight log pane and overall progress bar.
  - The receipt's detail table and proof print (proof print dropped in D14).
  - Activity chips for fuel and needs-you.
  - The wallet ids under wallet names.
  - The modal close ✕.
  - The radiogroup theme picker (rejected: it changes UX).
- **Seen, not changed: `StepStrip` checks a reachable step.** On the review screen, Review shows a check as if done. `main` does the same, so this is behaviour, not look, and it is out of scope.

## Test and copy edits
- `VerificationModal.test.ts`: "Verify the grid".
- `MainnetPlaceholderView.test.ts`: "Bridging is being upgraded".
- `tests/e2e/shell-smoke.test.ts:136` needed no edit: it asserts "to Aztec", and the toast lost its glyph prefix in phase 4.
- `accounts.spec.ts:109` moved to phase 6, with the label it asserts.
- `DripButton.test.ts` gained "takes the primary variant when asked". The existing secondary-default test is unchanged.

## Attempts
- **Lint caught a blank line** that the alias deletion left before the light block's `}`. `biome format` fixed it.
- **Modal scrolling.** A first draft gave `.modal` `overflow-y: auto`. That was dropped: a `.ul-notch` fill is absolutely positioned at the padding box, so scrolled content would slide off it. That draft's claim that the dialogs are short enough was wrong for the account chooser; see the arc 2 review below.

## Gate
- **PG PASS.**
  - `bun run lint`: 0 errors; the one warning is the pre-existing unused import in `useBridgeJournal.stages.test.ts`. The complexity baseline is OK.
  - `typecheck:all`: exit 0 in all three packages.
  - `test:all`: exit 0; `theme-vars.test.ts` fails on any leftover reference to an old token.
  - The jsdom smoke passes.
- **BG PASS.** Both builds pass `verify:build-target`, contain no `data:font`, and produce `_headers` byte-identical to `main`. `verify:deployments` is OK for all three records on the old live file.
- **Grep gates.** Uppercase, 1px and em letter-spacing: none. Legacy glyphs outside comments and tests: none. `color: var(--ul-signal)`: none.
- **`bun run e2e:tools`** exits 0 with 69 passed (1.2h, one worker, its own sandbox reaped).

## Arc 2 review loop
**Round 1.** `/codex high` (GPT-6 Astra; session `01a0ebde-8668-7922-a9f1-5c7e8c8f22a1`), prompted with the arc diff, plan.md, the arc map and both verbatim rules. Verdict: "request changes—mobile identity controls and accessibility regressions remain; confidence high in the reproduced findings". Each claim was checked in code, and each contrast figure with `theme-contrast.ts`.

1. **Accepted (material).** The journal's switch button overflowed a 390px card with a long alias: `Button` is `white-space: nowrap`. `.switch` now wraps, with `overflow-wrap: anywhere`.
2. **Accepted (material).** At 390px the wallet picker left about 51px for a name, so two self-reported names sharing a prefix read the same. `.name` now wraps in full; `NAME_MAX` (48) bounds it. The row keeps its layout.
3. **Accepted (material, inherited from `main`).** With 16 granted accounts, Continue in the account chooser fell off screen. The modal is capped at the overlay's height and `.rows` scrolls. The notched host itself does not scroll, and a 4px inset keeps focus rings inside the clip.
4. **Accepted (minor).** `TokenTile` hover put ink-3 on line: 3.37:1 dark, 3.57:1 light. It is now ink-2 (5.41/5.62). The inset focus ring on the selected ink tile was 2.61/2.88 and is now `--ul-bg` (16.76/15.78). `theme-contrast.test.ts` gains ink-2 on line and line on ink as text pairs, plus the inset ring.
5. **Rejected (minor, inherited).** `--ul-on-mark` on the generated monogram stripes falls under AA at some hues. The monogram is `aria-hidden` and repeats the symbol printed beside it, so it is decoration. `token-sprite.ts` is unchanged in this arc, and recolouring every token mark is a visible change outside the approved surfaces. Logged in `follow-ups.md`.
6. **Accepted (minor).** A `role="img"` cell hides its descendants, so the compact rail's live clock was invisible to assistive tech. The cell label now carries it ("Crossing, in progress, 1m 03s"). `BridgePhaseRail.test.ts` asserts that label.
7. **Accepted (minor).** Removed the `(plan Sxx)` citations: BridgeReceipt (flagged), plus the same pattern in `useBridgeJournal.ts`, `bridge-steps.ts` and `wallet-errors.ts`. Deleted three narrating comments: the receipt hero, `ReviewStep` `.lines` and `BridgeStepper` `.action`. Added the one invariant comment the rail label needed.

PG PASS after the fixes.

**Round 2** (resumed session). Verdict: "request changes—one new material regression remains, reproduced in Chromium with high confidence". Codex confirmed that the 16-account chooser now works at 390×844, that names and switch labels fit at 1440, and that the rail label adds no live-region chatter.

1. **Accepted (material, introduced by round 1).** Full-length names made the wallet picker taller than a phone screen: five long names pushed Cancel to y=847. The picker takes the chooser's fix: `.modal` capped at the overlay's height, and `.rows` scrolls with the 4px focus inset.
2. **Accepted (minor).** Stripped the provenance citations ("plan …", "post-impl audit …", "codex …", "P2") from the comments of every file this arc touched: ChooseAccountModal, deposit-flow, useBridgeJournal, fuel-claim-state and network. Every invariant stays. Twelve untouched files still carry inherited citations; they are logged in `follow-ups.md` rather than swept up in a reskin.

PG PASS after the fixes.

**Round 3** (resumed session). Verdict: "no material defects remain; one minor comment cleanup remains (high confidence)". Codex re-ran the five-long-names repro at 390×844, with and without the collision warning, in both themes: the modal stays within y=24–820, Cancel within y=752–796, and the list scrolls. It ends: "No material finding remains."

1. **Accepted (minor).** Dropped "approved Option B" from the WalletPickerModal header comment; the single-instance and claimed-identity constraints stay.

**The loop converged in round 3.**
