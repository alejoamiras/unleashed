# Phase 6 — bridge progress, journal, receipt

## Result
Gate passed.
- **PG:** lint, typecheck:all, test:all and the jsdom smoke all pass.
- **Gate tests:** the phase rail's progress assertion now reads `aria-valuenow` (strictly between 0 and 100) instead of matching `/▓+░+/`.
- **Phase 7 grep gates, run early on this phase's files:** no uppercase transform, 1px border or positive em tracking in `Bridge*.vue`; no glyph from the gate's set in `Bridge*.vue`, `lib/*.ts` or `composables/*.ts` outside comments; no `color: var(--ul-signal)` anywhere.

## What changed
- **Phase rail.**
  - Glyph text became icons: `hourglass` for pending, `loader` for active, `check` for done and `close` for failed.
  - Each compact cell is labelled "{phase}, {state}". The full rail's glyph is labelled with the state word, and the row's label carries the phase name.
  - The text bar is now a `role="progressbar"` with a signal fill, a 3px ink front edge and a line-coloured remainder. `aria-valuetext` reads "x of y".
  - The pulse is stepped and slow, and only the full rail's live glyph pulses. The done check stamps in over one tick.
  - The live row is signal-tint, clipped with `--ul-notch-2` directly. It is not a `.ul-notch` host, because its `::before` is the spine.
  - Retry is a small destructive `Button`.
- **Stepper.** It is a notched panel (px4). The header reads "Bridging" at 20px. Backup is a small secondary `Button` with the `download` icon, and "Run in background" is a quiet dotted-underline button.
- **Journal card.**
  - The card is a notched panel with a 4px status edge on its clipped fill: attention while the record needs the user, carrier once done.
  - The completion beat is a one-tune cut of the fill to carrier tint, plus a check and "Bridged"/"Released" stamped in over one tick. The old scaled `stamp-in` and the smooth `flash` are gone.
  - The privacy word is a `Tag`. The account chip keeps its `other` class (other-colour fill and text).
  - ✕ and ⤓ became `close`/`download` icons inside 36px corner buttons. Their `aria-label`s are unchanged.
  - Every action is a small `Button`:
    - Claim, Finish, Retry and Claim your gas are primary; Claim your gas shows the loader while it runs.
    - Switch to and Claim without fuel are secondary; Switch to is tinted with the other colour.
    - Discard is quiet, and turns destructive once armed.
  - The claimed-by-other and private-gas-unknown lines carry an `info-box` icon. The attention note is an attention-bg strip with `warning-diamond`. The discard warning carries `square-alert`.
  - Tx links read "Deposit tx", "Claim tx", "Exit tx" and "Finish tx", with an `external-link` icon.
- **Journal list.**
  - The title reads "Your bridges".
  - Restore is a small secondary `Button` with the `upload` icon; while restoring it shows the loader and "Restoring…".
  - The empty state is a notched well with the `audio-waveform` icon and "Nothing pending yet".
- **Receipt.**
  - The hero amount is split into two spans with the same text content: digits in Sixtyfour at `clamp(32px, 8vw, 48px)`, and the symbol in Mono.
  - The digits converge once on mount over `--ul-converge`, from `XELA 85, YELA -70, SCAN 70, BLED 60` to zero. Only the axes move.
  - Under the hero sits one 2px signal scanline at 0.4 opacity.
  - The done mark is a `check` icon labelled "completed". The carrier left rule is gone; the check is the only success colour.
  - The template comment on colour was rewritten to describe the new treatment.
  - The confetti is removed. Its bits were the ▓ ░ ✓ glyphs the gate bans, and the convergence is now the one arrival moment (the spec allows at most two pixel moments on a screen). **Owner sign-off via the PR screenshots.**
  - The CTAs are `Button`s: New bridge (or the caller's label) primary, Add {symbol} to wallet secondary with the loader.
- **Footer (bridge):** matches the phase-4 footer: ink-3 body, bold ink-2 labels, dotted links, no rule.
- **Copy (sentence case).** Button names inside guidance and notes follow the buttons: "press Claim", "press Finish", "Claim your gas". This covers the card, and the notes in `useBridgeJournal.ts`, `useHubExit.ts` and `deposit-flow.ts`. Code comments that name the buttons in capitals were left alone.

## Browser check (scratch spec, deleted)
A private 123.456789 USDC deposit ran through the stepper to the receipt, then to Activity, at 1440 and 390. No theme was forced, so these shots are light; dark comes with phase 7's pass.
- **The stepper headline was still upper case** ("ETHEREUM → AZTEC · … · PRIVATE"), built in `BridgeStepper.vue`'s script. It now reads "Ethereum → Aztec · 123.45 USDC · private", matching the receipt's eyebrow.
- **At 390 the hero broke mid-number** ("123.45678" / "9"). The first sizing was `clamp(32px, 8vw, 48px)`, and ten Sixtyfour characters at 32px are wider than the phone's ledger.
  - The fix makes the ledger an inline-size container. The digits get `--n` (their own character count) and a size of `clamp(20px, 100cqi / (n + 1), 48px)`, so an amount fits one line down to the 20px floor.
  - The face advances about 0.98em, measured from the 1440 shot (472px for ten characters at 48px).
  - The re-check at 390 is part of phase 7's responsive pass.
- The rest read as intended:
  - The Crossing row is signal-tint.
  - The done card's carrier edge and the "Bridged" stamp show.
  - The corner close sits right of the age.
  - The scanline sits under the hero.
  - New send is signal, Add USDC to wallet raised.

## Test and copy edits
- `BridgeJournalCard.test.ts`:
  - Direction, privacy, stamp, Claim, Finish, Retry, Confirm discard, "press Claim your gas", "Press Claim to verify" (×3) and "Switch to Savings" now read in sentence case.
  - The stamp test asserts "Bridged" and that no ✓ glyph is rendered.
  - Test names follow the new copy.
- `BridgeReceipt.test.ts`: the done mark is asserted as an `svg` with `role="img"` and label "completed", and no ✓ glyph renders. The `ctaLabel` fixtures and the assertion read "New fuel" / "New send". Test names follow.
- `BridgePhaseRail.test.ts`: the `/▓+░+/` match became an `aria-valuenow` range check.
- `SendWizard.test.ts`: a test name reads "Run in background".
- `tests/browser/specs/accounts.spec.ts`: `toContainText("Switch to")` and the test name. This edit was listed in phase 7, but it lands here with the label change it follows.
- `views/ActivityView.vue`: the journal title prop reads "Your bridges". The rest of that view is phase 7's.

## Decisions for the owner (PR screenshots)
- The receipt's confetti is gone; convergence plus the scanline is the arrival.
- The journal's done stamp is an icon plus the word, not "BRIDGED ✓". The check is decorative there, because the word already says it.
- Corner buttons are 36px, the spec's compact control size, not the 44px default. That keeps the card header one text line tall.
