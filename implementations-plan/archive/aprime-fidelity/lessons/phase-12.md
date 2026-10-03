# Phase 12 — Toasts and stepper Retry

## What was done

- **Toast anatomy.** `D:ui/Toast.vue` sits on `--ul-raised` with no edge stripe, `align-items: flex-start`, padding 14, 14/1.4 text. An optional `lead` renders in `<strong>` and `text` follows it on the same line (the board's "**Could not claim your gas.** Try again from Activity."). "View tx" moves under the text in a column (gap 4), accent 700, no underline, with an `external-link` 12. The dismiss is a 12px close in a 28px target, ink-3. A local kind `saved` draws `save` 24 in ink and renders no dismiss. A `ttlMs` prop draws a 2px bar inset 4px from each side (so it never crosses the stepped bottom corners) that shrinks over exactly `ttlMs` with `steps(24)`, via the `--toast-ttl` custom property; under reduced motion it has no animation (`!important`) and is hidden.
- **Wiring.** `useToast` entries carry the resolved `ttlMs` (6 s default) and an optional `lead`; a toast is typed as a lead, a text, or both. `AppToastRegion` passes `lead` and `ttl-ms`. Callers: the completion toast's phase 10 sentence is now its `lead`; the dock's failed gas claim leads with "Could not claim your gas." and follows with the wallet's reason or "Try again from Activity."; the recovery-file toast is kind `saved`, copy unchanged.
- **Stepper Retry.** `BridgePhaseRail`'s failed-phase Retry is `secondary` with `reload` 12; text and `tl-stepper-retry` unchanged.

## Tests

- `Toast.test.ts`: the lead is in `<strong>` and the text follows on one line; `saved` draws the save glyph and has no dismiss; the link sits in the body column; the countdown bar's `--toast-ttl` equals the TTL and no bar renders without one; the existing text, dismiss, link and kind cases stay.
- `useToast.test.ts`: an entry keeps its `lead` and `ttlMs` (6000 by default, 2000 when given) and leaves when its own TTL runs out.
- `useCompletionToasts.test.ts`: the four sentence assertions moved from `text` to `lead`, strings unchanged.
- `ActivityDock.test.ts`: the gas-claim failure pushes `{ kind: "error", lead: "Could not claim your gas.", text: <wallet reason> }`.
- `BridgeStepper.test.ts`: the Retry is the `secondary` variant, reads "Retry", carries the `reload` icon, and still routes to `runDepositClaim`.
- `useBridgeBackup.test.ts` does not pin the toast kind, so it is unchanged (the plan's condition). `tests/e2e/tools-smoke.test.ts` stays green unchanged (its drip toast passes `text`).

## Attempts and notes

1. Button's variant classes are CSS-module hashed, so the first Retry assertion (`classes()` not containing "destructive") could not fail; the test reads the `Button` component's `variant` prop instead, as `ActivityRow.test.ts` does.
2. Icons render no name attribute; the `saved` test compares the rendered path with `ICONS.save.d[0]`.
3. Tour, first run: every step after the recovery toast timed out clicking the rail's Bridge tab. After an account switch the test wallet's frame sits over the rail's first tab (the `⋮⋮⋮` box top left in every capture, a harness artefact). The tour clicks the tabs by `element.click()` since.
4. Tour, second run: the retryable-error card captured fine, but pressing its Retry never completed: after an injected `sendTx` failure the engine records a pending fuel-claim attempt and waits for its receipt ("fuel claim attempt pending - waiting for its receipt before retrying"), so the card returns to needs-you and never toasts. That is the engine's existing unknown-outcome guard, not this phase. The done card and completion toast were captured by a third, separate run: a deposit sent to the background with "Run in background" that completes on its own. The same guard kept the failed in-flight phase from reaching its receipt; the receipt capture is a clean foreground deposit.
5. The first recovery-toast capture caught the toast mid enter-transition (translucent); toast captures wait 700 ms since, still well inside the 6 s TTL for both themes.

## Deviations from the plan

- **The countdown bar is hidden under reduced motion** rather than left static at full width, since a full bar that never moves reads as a divider.
- **The countdown bar is the kind's ink at 60% opacity.** The board gives no colour or step count; 24 steps.
- **`lead`-only toasts**: the completion toast has a lead and no text. The toast entry type makes "neither" unrepresentable.
- **The `info` kind** (no board counterpart, recon G37) keeps its accent icon on the raised panel.

## Validation gate

Run:
- `bun run lint` exit 0 (Biome: 1 pre-existing warning, 2 infos; complexity-baseline check OK).
- `bun run typecheck:all` exit 0 (design, bridge-core, tools).
- `bun run test:all` exit 0 (design 236; bridge-core 447 + 1 skipped; tools 1530 in 106 files).
- `bun run --cwd apps/tools test:e2e` exit 0 (30 tests).
- Baseline: `git diff --exit-code <rev> -- scripts/complexity-baseline/manifest.json` exit 0.
- BG: `build:testnet` 0, `verify:build-target testnet` 0, no `data:font`, `_headers` diff 0; `build:mainnet` 0, `verify:build-target mainnet` 0, no `data:font`, `_headers` diff 0; `verify:deployments` 0 ("All committed addresses match").
- `bun run audit:tools` exit 0.
- `e2e:tools` (6 concurrent shards, `--shard=i/6`, each its own sandbox): all six exit 0, **70 passed** (17 + 7 + 17 + 11 + 13 + 5), no flaky. `agent.sh reap` afterwards: nothing to reap. The tour specs were deleted before this run.

## Screenshot tour (arc 4)

Specs `zz-arc4.spec.ts` (two runs) and `zz-arc4b.spec.ts`, each run alone with `agent.sh`, deleted before the full run and never committed. The report flags no horizontal scroll in any of the 94 captures:
- `06b-inflight-dock-*`: the running send as "this send" (open at 1440, strip at 1440/1100, the 1100 overlay over static after a tap, none at 390).
- `06-inflight-failed-*`: square-alert failed Claim phase with the secondary Retry + reload (1440, 390).
- `07-receipt-*`: "Arrived" hero (arc 5 restyles the rest).
- `08-activity-{needs-you,other-account,retry,lost,withdraw-running,running,done,done-toast}-*`, `12-dock-empty-*`, `14-dock-{needs-you,other-account,retry,lost,withdraw-running,done}-*`, `15-recovery-toast-*`.

Not reached by the harness: **a running withdraw in its prove phase** ("You can leave this page."). Holding the exit's `sendTx` and pressing "Run in background" left the withdraw card needs-you ("The exit was interrupted before its transaction was recorded. Press Finish…"), so the G131 line rests on its phase 10 unit test (`BridgeJournalCard.test.ts`).

### Board vs capture differences (not recorded decisions)

- **Toasts** match DCQComponents' Feedback specimens (raised panel, check/square-alert/save 24, bold lead, stacked "View tx" + external-link, 12px dismiss). The toast region (top right, z 1000) covers the open dock's Hide button while a toast shows; the board places toasts top right too. Flag.
- **A blocked (lost) card shows its reason on the amber warn band** inside a red-edged card, and its compact rail keeps the magenta live segment. Red chip and edge are right; the band colour and the live segment are phase 10 surfaces. Flag.
- **A retryable card says "Press Claim, then confirm in your Aztec wallet." above a button labelled Retry.** Phase 10 guidance copy. Flag.
- **Dock rows beside a word truncate line 2** ("ETH → Aztec · public + ga…", "· public …" beside "Lost signal"); the board's rows fit "ETH → Aztec · 2h ago". Phase 11 row meta. Flag.
- **A backgrounded exit whose wallet call is still pending reads Needs you with the "interrupted" guidance** instead of running. Pre-existing flow/runtime behaviour, surfaced by the tour. Flag for the verifier.
- **Tx links sit on their own row between the guidance and the actions** on needs-you, lost and running cards, which leaves a gap on a running card with no guidance (`08-activity-running-*`); the board has no link row on in-flight cards and puts done links on the "Arrived in" line (done cards already do). Phase 10 layout. Flag.
- **Retry glyph**: the board draws `repeat`; the plan's G119 names `reload`. Recorded decision, kept.
- **Receipt**: only the "Arrived" hero belongs to arc 4; the rest is arc 5.

## Flags for owner sign-off

- The countdown bar's colour (kind ink, 60%) and 24 steps; hidden under reduced motion.
- The trailing "Other account" dock group (no board draws it).
- Retryable failures red rather than amber, and "Lost signal" beside "Your funds are not lost - retry from this card." (Q6 B literal, Disputed M2) — visible in `08-activity-retry-*` and `06-inflight-failed-*`.
- The six board-vs-capture differences above.

## Codex post-implementation review, round 1 (PR layer 3)

Codex reviewed arc 4: two Medium and eight Low findings, three surfaced behaviours and a comment audit, no High. Both Mediums, four Lows, one surfaced behaviour and the comment audit were fixed; four Lows and one behaviour were left; one pre-existing behaviour became a follow-up.

Medium, fixed:
- **Gas-only amounts read as what arrived.** `displayAmountOf` gives a gas-only send's gross Fee Juice (`fuel.received`, or the signed floor), and claim fees come out of it after it lands. `DisplayAmount` gains `gross` (true only on that branch) and `amountQualifier` beside `displayAmountText` returns the one qualifier, "before claim fees". The completion toast keeps its lead and adds the qualifier as its text ("**Fueled Aztec with 2.00 FJ** before claim fees"); the card's header reads "**2.00 FJ** before claim fees · ETH → Aztec" beside the Arrived chip; a dock row gives it a third line (line 2 already truncates beside a word or button) and its open label reads "Open 2.00 FJ before claim fees, …". No net balance is computed. The token + gas chip ("+ N FJ") is unchanged. Tests: `asset-label` (gross and qualifier on both gas-only branches, none on a token send or a legacy fee-juice record), `rowStrings`, `ActivityRow`, `BridgeJournalCard`, `useCompletionToasts` (qualifier on a gas-only completion, no text on a token one).
- **A persisted block left the compact rail live.** `stepperPhases` fails the live phase of any record with `blocked`: done milestones stay, pending stay, and the failed phase carries no detail, since the card states the sanitized reason (a stale soft note must not narrate the failure). On a lost card that note takes `--ul-lost-bg` and a lost-coloured `square-alert` instead of the amber band and `warning-diamond`. The stepper offers no Retry on a blocked record, which never runs again. Tests: `BridgePhaseRail` (a loaded private deposit with `blocked`, a soft note and no attention: done, done, done, failed, pending, pending; the failed cell is "Crossing, failed"; no label says "in progress"; no detail), `BridgeStepper` (no Retry).

Low and surfaced, fixed:
- **"You can leave this page." on a lost card (low 4).** Only a running proving exit says it; the guidance comment now names that exception to the idle-only rule. Test: a busy proving withdraw with an error attention is lost and has no such line.
- **"Press Claim" beside Retry (surfaced).** The guidance verb is the button's label: Retry while the card retries, else Claim or Finish, in the deposit, withdraw and claimed-by-another lines. Test: a retryable deposit reads "Press Retry, then confirm in your Aztec wallet."; a retrying finish reads "Finish sent - press Retry to keep watching it confirm."
- **Narrowing dropped focus (low 6).** The `narrow` watcher runs before the render that unmounts the wide panel; with focus inside it, it focuses the strip's button after that render, and with focus elsewhere it does nothing. One test covers both; it fails with the focus lines removed.
- **Toasts over the header and Hide (low 7).** Above 760px the region starts at 88px (the header row and the dock's head are 72px); at 760px and below it sits at the foot of the screen, 16px from each edge, because the phone header wraps to its own height. The recovery toast keeps no dismiss. Measured in a throwaway dev-server capture (not committed) with a real recovery toast and a real two-line completion toast pushed through `useToast`: 1440×900, dock open, header controls y 12–60, Hide x 1356–1424 y 18–54, toasts x 939–1416 y 88–140 and 152–223; 1100×800, overlay open after a tap, header controls y 12–60, Hide x 972–1040 y 18–54, toasts x 599–1076 y 88–140 and 152–223; 390×844, header y 104–245 (controls y 185–233), no dock, toasts x 16–374 y 658–725 and 737–828. No toast overlaps the header box, any header control or Hide at any width, at the top or scrolled.
- **Disposable script references (low 8).** The gate-script names are gone from this log and from the phase 10 and 11 logs, which carried the same kind of reference.
- **Comments.** The activity module doc states its three invariants (block or attention over completion, completion over stale busy, ownership moves group and count only); `statusOf` says persisted completion metadata is taken as stored, never re-verified on-chain; the narration in `ActivityDock`, `ActivityRow`, `BridgeJournal` and `BridgePhaseRail`, `RecordChips`' import-category comments, `Toast.vue`'s invented rationale and `useBridgeBackup`'s plan reference are gone.

Left, with the reviewer's reason:
- **Low 1:** already fixed; `ActivityRowModel.blocked` is absent and phase 11 records its removal.
- **Low 2:** `BridgeJournal`'s three explicit wallet snapshots are small and clear; extracting them adds machinery without fixing a defect.
- **Low 3:** a terminal assertion in `record-policy.test.ts` would not distinguish the new `actionable` conjunction, since terminal attention already makes `retry` false; the blocked-plus-error test does. Codex checked the fueled receipt-mismatch result: false.
- **Low 5:** diagnosis rejected; on tablets the panel becomes a dialog, and the strip is the only complementary landmark named Activity.
- **Retry waiting on an unknown transaction:** the uncertainty guard in `deposit-flow.ts` stays; an injected failure does not establish that nothing was broadcast, so the attempt latch is not cleared to make Retry advance.

Follow-up (pre-existing, recorded in `follow-ups.md`): a backgrounded exit whose wallet `sendTx` is still pending reads Needs you with the "interrupted" guidance instead of Running (`useHubExit.ts`).

Observed, not changed:
- A record blocked during the session also carries a runtime attention whose note is the same reason, so until a reload its card prints the reason twice: in the rail's failed phase and in the note. Pre-existing.
- Persisted `completedAt` is not authenticated by token attestation: forged storage can fabricate completion metadata. The layer does not claim to prove settlement against storage forgery; `statusOf` now says so.

### Flags for owner sign-off

- The qualifier copy "before claim fees": after the gas-only completion toast's lead, leading the card's route line, and on a third line of a gas-only dock row.
- Toast position: 88px from the top, 24px from the right above 760px (was 24px/24px); the foot of the screen on a phone.
- A blocked card's compact rail: the live segment is red with the lost mark and reads "failed"; the blocked reason sits on the lost tint with a red `square-alert`, not the amber band.
- The instruction verb follows the button: "Press Retry…" beside Retry.
- A lost proving exit no longer says "You can leave this page."

### Gate

- `bun run lint` exit 0 (complexity-baseline OK; the one warning and two infos are the pre-existing ones). `bun run typecheck:all` exit 0. `bun run test:all` exit 0 (design 236, bridge-core 447 + 1 skipped, tools 1536 in 106 files). `bun run --cwd apps/tools test:e2e` exit 0 (30 tests).
- `git diff --exit-code <rev> -- scripts/complexity-baseline/manifest.json` exit 0.
- Browser, four concurrent `agent.sh` runs, each its own sandbox, all exit 0 with no retries or flakes: `specs/activity.spec.ts specs/spike.spec.ts` 10 passed (10.4m); `specs/recovery.spec.ts specs/l1-wallet.spec.ts` 9 passed (9.8m); `specs/exits.spec.ts` 7 passed (14.5m); `specs/accounts.spec.ts` 5 passed (6.1m). They cover the completion and recovery toasts, the restore path, the dock strip and its 1024 and 390 viewport pass, the other-account cards and dock group, and the exit cards. Each run stopped its own sandbox by pgid; `agent.sh reap` afterwards: nothing to reap.

### Round 2 (fix diff)

Two Mediums, both fixed. The dock qualifier rendered on grid row 2 over the route line: the later `.meta` rule won at equal specificity, so the selector is now `.meta.qualifier`. The "+ N FJ" gas chip on token + gas cards showed gross Fee Juice beside Arrived without the qualifier; it now reads "+ N FJ before claim fees" from one shared `GROSS_QUALIFIER`. Left, per the reviewer: the reason shown twice on a record blocked mid-session (pre-existing, misstates nothing). The failBlocked and displayAmountOf comments were narrowed to what they guarantee. New copy for owner sign-off: the gas chip qualifier. PG exit 0 (design 236, bridge-core 447 + 1 skipped, tools 1537, smoke 30).

Round 3: material findings 0.

## Re-tour after the review fixes

Retaken. One throwaway `zz-` spec held three tests, was run alone with `agent.sh` (3 passed), was deleted and was never committed. It used the tour's own flows, widths and themes. Its report flags no horizontal scroll in any of the 68 captures.

Retaken over the old files (46):
- **The gas chip.** Every token + gas card now reads "+ 50.00 FJ before claim fees": `08-activity-{needs-you,other-account,retry,lost,withdraw-running,done}-*` (1440/1100/390) and `08-activity-running-*` (1440/390). The longer chip pushes the age onto its own line at 390. Beside "Other account" it does the same at 1100.
- **The lost card.** In `08-activity-lost-*` and the lost card of `08-activity-withdraw-running-*`, the compact rail's live segment is red with the lost mark ("Crossing", failed). The blocked reason sits on the lost tint with a red `square-alert`. In `08-activity-retry-*` the guidance reads "Press **Retry**, then confirm in your Aztec wallet." beside Retry. The same card shows "Lost signal" beside "Your funds are not lost - retry from this card." over the red Claim segment: the Disputed M2 state that needs owner sign-off.
- **The toast position.** `15-recovery-toast-*-1440` and `08-activity-done-toast-*-1440` show the toast at 88px, clear of the account chips. `14-dock-other-account-*` is now shot right after the switch, so its "Active account" toast is deliberate: it sits below Hide with the dock open.

Added (22), states the old tour never showed:
- **The toast on a phone.** `15-recovery-toast-*-390` and `08-activity-done-toast-*-390` put the toast at the foot of the screen. They are shot at the viewport, not the full page, so they show what a phone shows.
- **A gas-only send.** The old tour bridged token + gas only, so these states are new:
  - `08-activity-gas-only-running-*` (1440/390).
  - `08-activity-gas-only-done-toast-*` (1440/390): "**Fueled Aztec with 30.00 FJ** before claim fees".
  - `08-activity-gas-only-done-*`: "30.00 FJ before claim fees · ETH → Aztec" beside Arrived.
  - `14-dock-gas-only-done-*` (1440, open) and `14-dock-gas-only-done-overlay-*` (1100): the row's third line, "before claim fees", which no longer draws over the route.

Not retaken: `06-*`, `06b-*`, `07-*`, `12-*` and `14-dock-{needs-you,retry,lost,withdraw-running,done}-*`. The fixes change none of their pixels:
- Dock rows carry no gas chip, and a token send has no qualifier.
- The stepper's failed phase belongs to a record that is not blocked.
- The receipt is untouched.

Two differences are timing, not the fixes:
- The retry and other-account captures no longer catch the incidental "Active account" toast at every width.
- The Retry press that stalled in the original run (attempt 4) was not repeated.

Looks wrong, not fixed here:
- **The 88px toast covers the Activity page's Restore** at 1440 and 1100 for its 6 s. The recovery toast has no dismiss. With the dock open at 1440, the toast covers the dock's first row and its action: the Switch row in `14-dock-other-account-*`. The measurement above checked only the header and Hide.
- **Two lost cards give their reason in two different styles.** A blocked card puts it on the lost tint with a glyph. A retryable failure's reason is plain text under the rail (the failed phase's detail).
- **"before claim fees" sits on the gas chip of needs-you and running cards** where no claim has run yet. It is true, but it reads oddly beside "Needs you". It is part of the qualifier copy already flagged for sign-off.
- **The gas-only running card's rail narration reads "waiting for the message to reach the L2"**: lower case, with "L2". This is phase 10 narration and predates these fixes.

## Toast placement, cross-arc review

The desktop toast region moved from 88px below the top and 24px from the right to the foot of the page column. Its left edge was then set on the content edge: `bottom: 24px; left: calc(var(--shell-rail) + 36px)`, where `--shell-rail: 200px` is declared on `.shell` in `AppShell.vue` and 36px is the body's gutter. The toast now starts at x 236, the same edge as the title, the cards and the footer. At 760px and below the region still spans the screen, 16px from each edge.

Retaken over the old files (12): `08-activity-done-toast-*`, `08-activity-gas-only-done-toast-*` and `15-recovery-toast-*`, dark and light, at 1440 and 390. They use the tour's flows and JPEG settings, and each is shot at the viewport, not the full page. The capture style now hides the parked harness panel as well as `iframe`, so it no longer sits over the logo. A theme switch runs a 90 ms stepped colour transition (`--ul-tick`). A capture taken straight after `setAttribute("theme", …)` catches the active tab's label and the backup icon mid-fade, so each capture waits 350 ms after the switch; four captures still fit inside the toast's 6 s.

Measured with `getBoundingClientRect` in throwaway `zz-` specs. Each was run alone with `agent.sh`, deleted and never committed. Activity used real toasts. Send used copies of the real toasts' markup placed in the live region, and each copy's box matched its original to the pixel at 1440×900. Rects are left,top–right,bottom in viewport px. "Two-line" is the widest real toast, gas-only completion (396×71). "Recovery" is the one-line saved toast (386×52). Every row below was re-measured at the 236 anchor except the 1100×800 overlay and the 390 Send rows. The overlay row keeps its x 224 figures. At 390 the anchor did not change.

| Viewport | Page and state | Toast | Controls | Covered |
|---|---|---|---|---|
| 1440×900 | Activity, one needs-you card, recovery | 236,824–622,876 | Restore 1038,100–1136,140; Claim 256,309–321,345; Discard 329,309–406,345; backup 1080,309–1116,345 | footer links |
| 1280×720 | same | 236,644–622,696 | Restore and card actions as at 1440 | footer links |
| 1100×800 | same | 236,724–622,776 | Restore 966,100–1064,140; Claim and Discard as at 1440 | footer links |
| 390×844 | same | 16,761–374,828 | Restore 276,321–374,361; Claim 36,582–101,618 | footer links |
| 1440×900 | Send amount step, dock open, two-line | 236,805–632,876 | dock 1140,0–1440,900 (Hide 1356,18–1424,54; first row 1156,101–1424,157; All activity 1160,867–1227,880); Continue 955,633–1080,681; Back 424,633–496,681 | footer links |
| 1280×720 | same | 236,625–632,696 | dock 980,0–1280,720 (All activity 1000,687–1067,700); Continue 795,651–920,699; Back 424,651–496,699 | **Back**, at scroll 0 |
| 1100×800 | Send amount step, dock a strip | 236,705–632,776 | strip 1056,0–1100,800; Continue 871,651–996,699; Back 424,651–496,699 | none (6px clear) |
| 1100×800 | same, overlay open (measured at x 224) | 224,705–620,776 | overlay 756,0–1056,800 (Hide 972,18–1040,54; All activity 776,767–843,780) | none; the toast sits above the scrim |
| 761×800 | Send amount step, strip | 236,705–632,776 | strip 717,0–761,800; Continue 532,752–657,800 and Back 424,752–496,800 once scrolled into view | **Continue and Back** |
| 390×844 | Send amount step | 16,737–374,828 | Continue 237,796–362,844 and Back 28,796–100,844 once scrolled into view | **Continue and Back** |
| 1440×900, 1280×720, 1100×800 | Send review step | as above | Sign and send 937,513–1080,561, 777,513–920,561 and 853,513–996,561; Back 424,513–496,561 | none |
| 761×800 | Send review step | 236,705–632,776 | Sign and send 514,660–657,708; Back 424,660–496,708 | **both**, at scroll 0 |
| 390×844 | Send review step | 16,737–374,828 | Sign and send 219,796–362,844 and Back 28,796–100,844 once scrolled into view | **both** |

"Footer links" are the contract links, Portal factory 294,847–368,865 to Bridge hub 604,847–665,865 at 1440×900. The 12px shift changed no row's covered set.

- **Stacks grow upward.** The newest toast takes the foot and older ones rise. At the x 224 anchor, two real recovery toasts at 1280×720 sat at y 580–632 above y 644–696, and at 390×844 at y 682–749 above y 761–828. Four two-line copies (the queue cap) topped out at y 375 at 1280×720, y 455 at 1100×800 and y 429 at 390×844, so the stack never leaves the viewport. The move changed only x, so these heights stand. At 390, four toasts cover the card's Claim, Discard, Deposit tx and backup.
- **A long list (six records).** This was measured at x 224, and the Claim, Discard and footer ranges lie inside the 236 band too. Scrolling passes every card's Claim (x 256–321) and Discard (x 329–406) under the toast at every desktop size; `elementFromPoint` confirmed the toast on top. At 1100×800 one card's pair sits under it from scroll 0 to 76. Restore, the tx links (from x 961) and the backup icon (from x 1008) never pass under it at desktop widths. At 390, every card action does.

What it can still cover:
- **The footer's contract links**, on any page shorter than the viewport, at every width. The shell's `min-height: 100vh` pins the footer to the foot. The cover lasts 6 s.
- **The wizard's Back on the amount step at 1280×720.** From the measured rects, a two-line toast reaches it on any desktop height below about 780px. From 1100px up, Continue starts right of the toast's widest possible edge (x 716, the 480px maximum from x 236).
- **At the narrowest desktop layout (761px), the wizard's primary button too**: Continue once it is scrolled into view, and Sign and send at scroll 0. A toast at its 480px maximum would end at x 716, 1px short of the strip.
- **A card's Claim and Discard** when they are scrolled into the band.

Nothing measured touches Restore, the account chips, the dock (head, Hide, rows, All activity), the strip or the open overlay.

The recovery toast has no dismiss, so each of these covers lasts its full 6 s. That is plan G121 (kind `saved`: no dismiss), from the approved board, and it stays. Flag for owner sign-off: the bottom-left anchor at the content edge, what it still covers above, and G121's undismissable recovery toast over those controls.
