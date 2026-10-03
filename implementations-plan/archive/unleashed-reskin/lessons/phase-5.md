# Phase 5 — send wizard and veil line

## Result
Gate passed.
- **PG:** lint, typecheck:all, test:all and the jsdom smoke all pass.
- **Gate tests:**
  - `send-model.test.ts` covers the three `tokenRemainder` cases.
  - AmountStep's two veil tests pass: the line and its "hidden amount" label on a private deposit, and no line when public, on an exit, or for gas only.
- **Browser check (scratch spec, deleted):** a funded account walked token → amount (token + gas, private on) → review with details open, in dark and light at 1440, then the amount step at 390 with no sideways scroll.

## What changed
- **`tokenRemainder(amount, gas)`** lives in `lib/send-model.ts`. GasBreakdown, ReviewStep, the permission-record builder in SendWizard and the veil line all use it; the three inline copies are gone.
- **Veil line.** It sits under the Private switch, inside the switch's raised card: "Others on Aztec see" + a `.ul-veil` swatch (`role="img"`, "hidden amount") + "· you see {remainder} {symbol}". It shows only on a deposit with Private on and a remainder above zero.
  - For token + gas it waits for the gas plan. Otherwise it would show the whole amount while the split is still being priced, then shrink.
  - The swatch is not notched: `.ul-veil` sweeps in by animating its own `clip-path`, and a notch polygon would turn the sweep into a jump.
- **Amount field.** It is the notch host: a well with a 2px state edge on the clipped fill (ink-3, focus, or lost).
  - The block cursor renders only under `@supports (field-sizing: content)`. Without that, the input cannot hug its text and the block would float at the far end.
  - The native caret stays visible (signal-coloured), so mid-string editing still shows where the caret is.
- **Buttons.** Wizard navigation, "Add" on a looked-up token, and Sign and send now use the `Button` primitive; the hand-rolled `.btn` rules are gone. Sign and send shows the pixel loader while busy.
- **Selection.** Selected choice cards, token rows and the direction segment are reverse video (ink fill, bg text). Their secondary text takes `--ul-line`, which reads on ink in both themes (#3a3a42 on #ededea and #cfc9ba on #18171c, both about 10:1).
  - Unselected token rows are raised. The board shows them transparent on the live screen and raised on the Components sheet; raised gives them an edge without hairlines.
- **Step rail.** Done steps are a carrier-bg marker with a `check`; the current row is signal-tint with a signal marker; upcoming steps have a 2px ring. Hints are sentence case. The spoken caption keeps its lower-case clause after the em dash.
- **Notes.** Dashed boxes became notes with an icon:
  - ReviewStep's first-time and burn notes are raised with a 4px edge.
  - Warnings carry `warning-diamond` and errors `square-alert`.
  - The stale-review strip is attention-bg.
- **Token sprite:** squares instead of discs, drawn in Atkinson Hyperlegible Mono and notched by the tile. The monogram's hue stripes stay: they keep two tokens with one ticker from looking alike.
- **Copy (sentence case):** choice labels, nav buttons, "Minting…", "Add", "New send", "Add {symbol} to wallet", every bridge phase label in `bridge-steps.ts`, and step hints. "Sign & send" became "Sign and send", matching the board and the declined-grant message that already names the button that way.

## Test and copy edits
- `AmountStep.test.ts`: two veil tests added; "CONTINUE" in three test names → "Continue".
- `send-model.test.ts`: new file (`tokenRemainder`).
- `TokenStep.test.ts`: "CONTINUE" → "Continue" in the no-footer assertion and its name; "ADD" → "Add" in a test name.
- `MintStrip.test.ts`: "MINTING…" → "Minting…".
- `ReviewStep.test.ts`: "SENDING" → "Sending".
- `SendWizard.test.ts`: "ADD WBTC TO WALLET" → "Add WBTC to wallet"; "NEW SEND" in a test name → "New send".
- `bridge-steps.test.ts`: eleven phase-label assertions follow the sentence-cased labels.
- `BridgePhaseRail.test.ts`: "CROSSING" → "Crossing" (the rail renders the bridge-steps label).
- `testids.ts` gains `sendPrivacyVeil`.

## Attempts
- **The vertical step rail stretched.** Each step kept `flex: 1` from the horizontal segment rule and grew to fill the rail's column. `.vertical .step { flex: none }` fixed it.
- **The selected choice's check was invisible.** `Icon` defaults to `currentColor`, and the selected card's text is bg-coloured, so the check came out bg on a bg box. The box now sets ink.
- **The gas stepper overflowed at 390.** "Gas for" plus a 148px count and two 40px buttons is wider than the card; the head wraps under 760px.
- **The look spec's first run had no USDT.** The spec account holds none. Clicking the in-app mint strip showed no status within 60 s under the injected wallet; I did not investigate why. The spec then minted server-side with `mint(sandbox.clients.l1, …)`, as the deposit specs do.

## Carried to phase 7
- `--txt-white` still backs the monogram, lookup mark and `Icon`'s `white` colour. The contract step needs a `--ul-*` home for "text on a brand-coloured mark" before the aliases go.
