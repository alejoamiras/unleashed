# Phase 10 — Status model, cards and the Activity page

## What was done

Commit group 1 (steps 1–4), landed after PG and `agent.sh specs/accounts.spec.ts specs/recovery.spec.ts` (9 passed):
- **Status model.** `lib/bridge-steps.ts` exports `isFailedAttention` (the rail's own failed set, now shared). `lib/activity.ts` `classify` returns `status`, `group`, `rank`, `counts` and `action`: lost (persisted `blocked` or any runtime attention) > done (completed, or stage done) > running (busy) > needs-you; a lost record groups with needs-you on any account; a needs-you record of another granted account groups as `other-account`; `counts` is lost-or-needs-you of the active account. Actions keep today's gates (completed → `doneAction`, busy → none, else `openAction`). `runningWord` names the prove phase "Proving" and any other by its label. `needsYouCount` and the feed's `autoOpenIds` read `counts`; `groupRecords` gains `otherAccount`. `record-policy.ts`: `showClaimWithoutFuel` also requires `actionable`.
- **R5-1.** `lib/asset-label.ts` `displayAmountOf(rec)` (tests first) plus `displayAmountText(d)` ("≥ " before a floor, "—" for nothing). `lastCompleted` carries `display` (read from the persisted record at completion, so a gas-only deposit's `fuel.received` is current) in place of `amount`; the completion toast, `BridgeStepper`'s headline and the restore toast read it.
- **Chips and cards.** New `RecordChips.vue` on the arc 1 `Tag` (small): Private (private tone, eye-off) or Public (neutral, eye); the gas chip (ink, zap; "+ N FJ"/"+ N Private FJ", or "+ FJ gas" before the event); the status chip (warn "Needs you", ink + hourglass running word, carrier "Arrived", lost "Lost signal"). `BridgeJournalCard.vue`: header amount (Mono 15/700, `displayAmountOf`) · `routeWords` · chips · the other-account chip (`Tag` tone other, wallet 12, "Other account · alias", full address in `title`, `tl-journal-account` and `.other` kept) · age ink-3 right; `data-status` drives a 4px amber (needs-you) or red (lost) edge and the amber live cell; stamp, done edge, done-flash and stamp-in deleted; guidance 14px as template segments with the bold verb (`*word*` marks in static copy, never HTML), ink when the record counts; G58 guidance first when another account owns it, with the Switch (secondary, wallet 12) beside it; G131 "You can leave this page." on a busy proving withdraw; G64 no rail for another account, which then prints its own sanitised failure note; G25 "Arrived in ‹Mono›" (plain "Arrived" when `completedAt ≤ createdAt`) or "Previously recorded as arrived" on a lost completed record, links 14/700 gap 18 right-aligned in the same row; Clear a quiet button in the actions row; Backup a 36×36 save-24 icon button at the end of the actions row (`aria-label` "Back up this bridge"); Retry secondary with `reload` 12; card padding 18 20, buttons 0 14. Every completion claim on a lost record is qualified (the claimed-by-other lines, the private-fuel-unknown note), and a lost card's gas recovery reads "Recover your gas" with a title that makes no arrival claim.

Commit group 2 (steps 5–7):
- **Compact rail.** The live segment holds a fill sized to `progress.fraction` with a 2px ink edge; its `aria-label` carries "n of m"; the compact bar, count and clock are gone; done labels ink-3, marks kept; the failed glyph is `square-alert` (both rails); `@keyframes stamp` and its rules are deleted. On a needs-you card the fill (not the whole segment) turns amber.
- **Journal page.** h2 17/700 with the heading tracking token and a Mono 13 ink-3 "N record(s)"; the list is a `ul role=list` of `li`, gap 12, ordered by `classify(…).rank` then newest first; the "Records live in this browser…" note (info-box 12, 13 ink-3) under the list; Restore 40px, padding 0 14, gap 8; the default empty slot is the new `EmptyChannel.vue` (raised row, tv 24, "Nothing on this channel yet", the restore link kept).
- **Receipt.** The hero word is "Arrived" for deposits, exits and gas-only sends.

## Tests

- `activity.test.ts`: the classify table gains status, group and counts with the plan's rows (any attention, `blocked` alone, completed + `blocked`, busy + `blocked`, busy + error → lost; busy → running; completed + stale busy → done; idle proving withdraw → needs-you; terminal × other account → lost, group needs-you, not counted, no action; needs-you × other account → other-account, not counted); one rank case; `needsYouCount` counts a lost row and skips an other-account one; `runningWord`. The parity pin is unchanged.
- `record-policy.test.ts`: a blocked record never offers claim-without-fuel.
- `useActivityFeed.test.ts` / `ActivityDock.test.ts`: lost rows count and auto-open; other-account rows never do.
- `asset-label.test.ts` (5 new), `useCompletionToasts.test.ts` (own symbol and decimals; a gas-only floor), `BridgeStepper.test.ts` (gas-only headline), `BridgeJournal.test.ts` (6-decimal and gas-only restore toasts; order and count), `useTokenCatalog.test.ts` (a remote entry claiming `source: "manifest"` stays `list`, no brand).
- `BridgeJournalCard.test.ts`: short route; Arrived chip and duration, plain "Arrived" at `completedAt ≤ createdAt`; `data-status` needs-you and lost, completed + blocked included; blocked + completed + recoverable public fuel keeps "Recover your gas" and never says the tokens arrived; blocked private-fuel-unknown and claimed-by-other lines qualified, no claim-without-fuel; gas-only amount in FJ; running proving withdraw; the bold verb; no chip for the active account or an out-of-grant recipient; the other-account chip, guidance, no rail; other-account + `receipt-mismatch` prints the sanitised note with no Claim or Retry; claimed-by-other on another account shows the G58 guidance, never "Press Claim". `:154,264,227-240,270` unchanged.
- `BridgePhaseRail.test.ts`: no visible clock, the label carries the progress, the fill width; the failed glyph's path. `BridgeReceipt.test.ts`: "Arrived" at `:39,64,85,155,256`.
- `accounts.spec.ts`: after switching to the owning account, `tl-journal-account` has count 0.
- **Failed on main first:** with the base versions of `asset-label.ts`, `useCompletionToasts.ts`, `BridgeStepper.vue`, `BridgeJournal.vue`, `BridgeJournalCard.vue`, `lib/activity.ts`, `record-policy.ts` and `useBridgeJournal.ts` checked out over the new tests, 52 of 127 failed, among them every R5-1 case (displayAmountOf, the toasts, the stepper headline, the restore toast, the gas-only card) and every completed + blocked case (the classify rows, the card's `data-status`, the qualified copy, claim-without-fuel); the implementation was restored from HEAD afterwards.

## Attempts and notes

1. An inline `python3 -c` edit with escaped template literals failed its own assertion (a `‮` escape); the edits moved to script files.
2. The first card test run showed "Arrived in" glued to its duration: a space-only text node at the start of a `<template v-if>` is dropped by the compiler, so the space is an interpolation.
3. Three dock tests used a blocked row as "counts but never opens"; with `autoOpenIds = counts` it opens. They now seed the seen set (already-seen rows badge without opening), and the never-opens case is an other-account row.

## Deviations from the plan

- **The dock lists the other-account group already** (a plain "Other account" section): `classify` moves those rows out of needs-you in this phase, and without the section they would vanish from the dock until phase 11 styles it.
- **Other-account cards keep their status chip and amber edge**, as the plan's Security section says ("keep their status chip and edge"); the board draws neither on card 4. Flagged below.
- **The other-account chip renders only when `ownedByOther`** (G57): a recipient outside the current grant, which used to show a grey address chip, now shows none; the engine's guard still explains a refused claim.
- **`displayAmountText`** sits beside `displayAmountOf`: the "≥ " floor and the "—" are the same on four surfaces, so they live once.
- **`autoOpenIds` equals `counts`**, as the Status derivation says: a needs-you record with no dock action (stuck before send, an exit never sent) now opens the dock once, like a lost one.
- **The Backup button keeps its descriptive `title`** ("Download this bridge's recovery file…"); only the accessible name became "Back up this bridge".
- **"You can leave this page."** shows only while a withdraw is busy in proving; an idle proving card keeps "Press Finish to resume…".
- **The first-visit hero keeps its well**: the journal's empty wrapper takes the well classes only for a caller's own slot, so the default `EmptyChannel` row is not boxed twice.
- **`data-status-chip`** marks the status chip for unit tests; no new testid.

## Validation gate

Run:
- PG: `bun run lint` exit 0 (complexity-baseline OK; the one warning and two infos are the pre-existing ones). `bun run typecheck:all` exit 0. `bun run test:all` exit 0 (design 233, bridge-core 447 + 1 skipped, tools 1520 in 105 files). `bun run --cwd apps/tools test:e2e` exit 0 (30 tests).
- Baseline: `git diff --exit-code <rev> -- scripts/complexity-baseline/manifest.json` exit 0.
- `agent.sh specs/accounts.spec.ts specs/recovery.spec.ts specs/l1-wallet.spec.ts specs/exits.spec.ts specs/activity.spec.ts` exit 0, `24 passed (33.0m)`; the sandbox was stopped by its own pgid.

## Flags for owner sign-off

- **Retryable failures are red "Lost signal"** beside notes such as "Your funds are not lost - retry from this card." (Q6 B literal, Disputed M2).
- **Other-account cards carry a status chip and edge** the board does not draw (Security: ownership never changes status).
- **The needs-you count drops other-account records** (OQ28); lost records of the active account now count and open the dock.
- **Cards drop "review said / you got"** (D18); the receipt keeps it.
- **New copy:** "Previously recorded as arrived", "They were previously recorded as arrived.", "Previously recorded as claimed by another submitter.", "Recover your gas", the G58 guidance, "You can leave this page.", "Records live in this browser. Back one up to finish it somewhere else.", "Nothing on this channel yet".
- Arc 4's screenshots come with phase 12's tour (the LG for PR 3).
