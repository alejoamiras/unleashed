# exit-finish-1: owner asks

Each entry: the surface, today's state, the options with their copy, a recommendation, and what ships while it is
open. Surfaces: the exit's Activity card (`BridgeJournalCard`: badge, the Exit · Prove · Finish · Confirm rail, note,
guidance line, links, button), the dock row (`ActivityRow`), and the wizard's full stepper (`BridgeStepper`).
Pictures: the real components on the testnet dev build with a seeded journal, light theme, named
`<entry>-<option>-<width>.png` at 1280 and 390 px, beside the plan in `design/` (not committed). Copy for states the
code cannot reach yet is set in the page for the picture; the dock exists only at desktop widths, so its pictures
are 1280 only.

## Answered (page 19)

- **E0 → P19-01 A**: a finish the wallet sped up while the app watched completes on today's done card ("Arrived",
  Finish tx link to the transaction that landed); one cancelled in the wallet shows today's "The finish transaction
  failed — finish again from this card. Nothing was lost." instead of "Arrived". Arc a1 is approved.
- **E1 → P19-02 B**, signed together with ask60: "Still confirming on Ethereum. Press Finish to keep checking —
  nothing is sent again, and your funds are safe either way." **This revision changes it** (W1, W2): ask60 asks the
  app to keep checking by itself, and the control that resumes watching is not labelled Finish.
- **E2 → P19-03 A**: today's done card, "Arrived", the Finish tx link to the transaction that landed, the toast
  "Released <amount> to Ethereum · View tx". Unchanged; it can now appear without a press.
- **E3 → P19-04 D**: store the finish's sender and nonce (two fields, also in backups); used and unpaid at one block
  → "Your finish transaction didn't go through — it was cancelled, replaced or reverted. Finish again from this
  card. Nothing was lost." Unchanged in words and control (Retry); it can now appear during the watch.
- **E4 → P19-05 A**: "Ethereum shows this withdrawal's message already used, but the app can't verify which
  transaction finished it — for example one you sped up in your wallet. Check your Ethereum wallet; this record
  stays open.", Retry. Unchanged in words and control; it can now appear during the watch, and ends it.

**What ships while W1–W5 are open**: arc a1 only (approved). Arc a2 waits for all five.

## W1. The card while the app keeps checking by itself

After the first wait (about 3 minutes) the app checks again by itself, through the build's own Ethereum reader, with
no wallet needed, for up to 30 minutes while a page is open. The card is busy throughout (no button, no Discard),
the rail on Confirm.

- **Today** (`g1-today`, stepper `h1-today`): the step line "waiting for the Ethereum confirmation" for about 12
  more minutes, then "Lost signal" and "The finish transaction failed — finish again from this card."
- **(a)** (`g1-a`, stepper `h1-a`): "Not confirmed yet. The app checks again by itself for up to 30 minutes while
  this page is open; nothing is sent again."
- **(b)** (`g1-b`): "Still confirming on Ethereum — checking by itself for up to 30 minutes."
- Recommendation: (a). It says that the finish has not confirmed, that the app is the one checking, until when,
  under what condition (an open page), and that nothing is sent again.
- Ships now: nothing (a2 waits).

## W2. The card after the bound: its note, its control, and the bound itself

The app stops checking after the bound; the finish's hash is kept; nothing is cleared or called failed.

- **Today**: the failed card above (`e1-today`).
- **Bound**: **(i) 30 minutes per page visit** (the deposit card's soft cap, which P19-02 B names); (ii) 60
  minutes; (iii) the tab's life (no bound; a forgotten tab polls the shared public endpoints every 4 s forever).
- **Note**: **(a)** (`g2-a`): "Not confirmed after 30 minutes of checking. Nothing is sent again, and your funds are
  safe either way." **(b)** (`g2-b`): as (a), plus "If you speed it up in your wallet, the app follows it when it
  can; otherwise this record stays open with a note." (a replacement that mines between two of the app's waits, or
  while no page is open, cannot be followed).
- **Control and guidance**: **(a) "Check again"** (`g2-a`), guidance "Finish sent — press *Check again* to keep
  watching it confirm."; (b) "Keep checking" (`g2-b`), same guidance with that label. Notes and labels combine freely.
- Recommendation: bound (i), note (a), control (a). (b) is true but hedged; the speed-up path is explained by
  P19-05 A's note if it is ever reached.
- Ships now: nothing (a2 waits).

## W3. A second tab while the first one checks

- **Today** (`g3-today`): "Lost signal" style, "Another tab is finishing this exit — try again in a moment.", Retry;
  the second tab never takes over.
- **(a)** (`g3-a`): busy, no button, "Another tab is checking this finish. This page takes over if that tab closes."
  The tab retries about every 3 minutes within its own 30-minute window.
- **(b)** keep today's card.
- Recommendation: (a). Today's Retry in that tab only repeats the refusal.
- Ships now: nothing (a2 waits).

## W4. The dock row's button for a finish already sent

- **Today** (`g4-today`): "Finish", which only resumes watching.
- **(a)** (`g4-a`): the label W2 picks ("Check again"). A record without a sent finish keeps "Finish"; errors keep
  "Retry".
- Recommendation: (a). ask60 rules out Finish for this control.
- Ships now: nothing (a2 waits).

## W5. The wizard's full stepper after the bound

The send wizard shows a full stepper for the exit it started. Its rail offers a button only on a failed phase, so
after the bound a2 alone would show the Confirm phase with "Waiting for the Ethereum confirmation…" and "usually
under 2 min", and no control (`h2-today`), which is untrue after 30 minutes.

- **(a)** (`h2-a`): the Confirm phase shows W2's note in place of the prompt, drops the estimate, and offers W2's
  control (Check again).
- **(b)** (`h2-b`): the note without a control; the dock row (W4) and "Run in background" lead to the card's control.
- Recommendation: (a). The screen the user is looking at should carry its own next step.
- Ships now: nothing (a2 waits).
