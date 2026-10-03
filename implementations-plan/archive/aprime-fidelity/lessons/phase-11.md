# Phase 11 — Dock

## What was done

- **Feed.** `useActivityFeed` appends the record whose stepper is on screen (`activeFlowId`, read from `journal.records`) as a `foreground: true` row: group running, no action, `counts` false, so it never badges or enters `autoOpenIds`. `ActivityRowModel` gains `status` (the classified status) and `foreground`; the unused `blocked` flag goes (a lost status says it now). `phase` holds `runningWord` (prove → "Proving"); the lower-case `phaseWord` had no other consumer and is deleted. `rowStrings` reads `displayAmountOf` + `displayAmountText`, so a gas-only row shows its Fee Juice (test written first; it failed with "0.00" before the fix).
- **Rows.** `ActivityRow` is an `li`: the amount and symbol one Mono 700 14 ink run; line 2 uniform 12.5px ink-2, "route · visibility · age", "route · age" beside a button, "route · this send" for the foreground row; row-gap 2; dot and side span both lines. Side word by status: running word (ink-2 400; the foreground row signal/700 with a signal dot), "Arrived" with check (carrier), "Needs you" (amber), "Lost signal" with square-alert (red). Done rows keep the board's transparent fill but are no longer dimmed. Buttons 14px; Retry secondary on `--ul-line` with `reload` 12; the needs-you Claim/Finish stays the one filled call; a busy Claim gas keeps its label, sets `aria-busy`, shows `BusyPixels` on the signal tint. The dock sends a foreground row's click to `shell.goTo("send")`, any other row to its card.
- **Strip.** Variant A: chevron 24 ink-2, un-notched 16px Mono 11/700 badge at top 10 / right 4, label 13/400 ink-3. The strip aside is named "Activity"; its chevron has `aria-expanded` and, while open, `aria-controls` → the panel's id; Hide has `aria-expanded="true"` and the same `aria-controls`.
- **Open dock.** Headings "Needs you · 1" in one run; groups 18 apart, heading → list 8, rows 6, list padding 8 16 0; "All activity" 13px, no arrow; lists are `ul role=list`; the trailing "Other account" heading is lilac; the empty dock is `EmptyChannel` with the board's sub "Bridges you background or lose track of land here."; the panel is always `aria-label="Activity"`. `groupRecords` puts lost rows first inside a group, then newest first.
- **761–1100.** A local `overlayOpen`, set only by `toggle()`; `shown = narrow ? overlayOpen : dock.open`; a `.ul-scrim` (`tl-dock-scrim`, z 19 under the panel's 20) hides on click. A narrow hide calls the new `useDockState.markSeen` (seen ids, no "hidden" write); the auto-open watch also watches `narrow` and skips while narrow without marking anything seen; `overlayOpen` resets when the layout widens. The hand-written Tab trap is gone: `useFocusTrap(panel, { enabled: overlay, onEscape, shouldYield })`, initial focus on Hide via `data-autofocus`.
- **≤760.** `PHONE_QUERY` exported from `useMediaQuery.ts` and used by `RailNav` and `AppShell`; the shell mounts no dock at ≤760 (`v-if="feed && section !== 'activity' && !phone"`); the unreachable phone overlay rule is deleted.
- A stale comment ("CLAIMING…") updated.

## Tests

- `activity.test.ts`: `rowStrings` of a gas-only record reads FJ (floor included, "≥ 1.00"); the `phaseWord` case removed with the function.
- `useActivityFeed.test.ts`: the foreground row (running group, no action, not counted, not in `autoOpenIds`, `liveIds` still knows it); other-account group; a gas-only foreground row shows "3.00 FJ".
- `ActivityRow.test.ts`: `li` root and one-run amount; meta beside a button; running word; "Arrived" + check; "Lost signal" + square-alert and "Needs you" with no action; Retry with reload and not filled; acting keeps "Claim gas" with `aria-busy` and `BusyPixels`; the foreground case (`aria-current`, "this send", no `activityRowAction`).
- `DockStrip.test.ts` (new): the aside name, `aria-expanded`/`aria-controls`, badge only while closed.
- `ActivityDock.test.ts`: headings `["Needs you · 1","Running · 1","Done · 1"]` and `ul > li`; the empty channel; a lost (older) row sits first in Needs you, other-account trails; the foreground row goes to Send; `:77`'s never-badge case stays; the gas claim shows "Claim gas" + `aria-busy`; narrow: a tap opens the dialog over the scrim, Escape closes and refocuses the strip; a persisted "open" is ignored, auto-open suppressed and unconsumed, a scrim click hides and leaves `unleashed:tools-dock` unwritten while marking the row seen; a desktop↔tablet resize (resizable `matchMedia` stub) turns the trap on only while the overlay shows, with exactly one `keydown` add and one remove on the document; another `aria-modal` keeps Escape and Tab.
- `useDockState.test.ts`: `markSeen`. `AppShell.test.ts`: phone `matchMedia` ⇒ no `tl-dock` on Send or Faucet, the rail still shows the count; the desktop cases prove >760 unchanged.
- `tests/e2e/shell-smoke.test.ts` test 7 rewritten: the foreground record never opens the dock or badges; opened, the dock shows it with `aria-current`, "this send" and no action; after release the dock opens itself with it as a needs-you Claim row.
- `spike.spec.ts`: the viewport test split into "tablet: at 1024 px …" (no dock until the tap, `aria-modal`, scrim visible, Escape hides both, deposit lands) and "phone: at 390 px there is no dock, even with a persisted open …" (`unleashed:tools-dock` seeded "open" before the reload; `tl-dock-strip` and `tl-dock` count 0 at review, in the stepper and at the receipt; deposit lands).

## Attempts and notes

1. `useFocusTrap` listens on `document`, the old trap on `window`: every dock test that dispatched keys on `window` now dispatches on `document`.
2. The spike's first version seeded the dock key as a string literal; the spec imports `DOCK_KEY` from `src/composables/useDockState` instead.
3. The first "lost row first" dock test passed only because the lost row was also the newest; with the lost row older it exposed that `groupRecords` sorted by age alone, so the sort now puts lost first.

## Deviations from the plan

- **The foreground row is always grouped Running, but its word follows its status**: a send waiting on its stepper's Claim reads "Needs you" (amber) and a failed one "Lost signal" under the Running heading, rather than a running word that would misstate it. Neither counts nor offers a button.
- **`blocked` left `ActivityRowModel`**; `status` replaces it (it was unread by any component after phase 10).
- **`phaseWord` deleted**; `runningWord` is the one phase word for cards and rows.
- **`groupRecords` orders lost rows first** within a group (the plan's "a lost row sits first in Needs you" needed it).
- **The foreground row counts in the foot's "N records"**, as the board's "4 records" does.
- **The strip's badge is `aria-hidden`** (the board's markup); the chevron's label already carries the count.
- **`overlayOpen` resets when the layout widens**, so a tablet session that grows past 1100 falls back to the persisted choice and does not reopen the overlay when it shrinks again.
- **A busy dock button uses the signal tint and ink** like `Button`'s loading primary, including on the outline Claim gas.

## Validation gate

Run (the browser run before the commit that changes one comment):
- PG: `bun run lint` exit 0 (complexity-baseline OK). `bun run typecheck:all` exit 0. `bun run test:all` exit 0 (design 233, bridge-core 447 + 1 skipped, tools 1528 in 106 files). `bun run --cwd apps/tools test:e2e` exit 0 (30 tests).
- Baseline: `git diff --exit-code <rev> -- scripts/complexity-baseline/manifest.json` exit 0.
- `bash apps/tools/scripts/e2e/agent.sh specs/spike.spec.ts specs/activity.spec.ts specs/accounts-single.spec.ts` exit 0, `11 passed (11.2m)`; spike's tablet (1024) and phone (390) tests both passed. The sandbox was stopped by its own pgid.

## Flags for owner sign-off

- **The foreground row's word under Running** can read "Needs you" or "Lost signal" (above).
- **The trailing "Other account" dock group** is not on any board (lilac heading).
- **A tablet hide marks the needs-you rows seen**, so the wide layout will not later auto-open for them; nothing auto-opens below 1100 and nothing at all at ≤760, where the rail's count is the only signal (Q3 A).
- **New copy:** "this send", "Show this send, …" (the foreground row's accessible name), "Bridges you background or lose track of land here." (board copy).
- Arc 4's screenshots come with phase 12's tour.

## Verifier round 1

Accepted (all three verified against the code first):
- **Foreground row painted lost and needs-you magenta** (medium). `.row.foreground .word`/`.dot` tied `.row[data-status=…] .word`/`.dot` at (0,3,0) and came later, so a held or failed send under Running read magenta, contradicting the deviation above. The signal colour now applies only to `.row.foreground[data-status="running"]`; the deviation text stands as written. jsdom cannot see colour, so no unit test; phase 12's tour shows it.
- **Tablet: the running send's row left the overlay over Send** (low). `goTo("send")` keeps the dock mounted (only Activity unmounts it), so the scrim and panel stayed. `open()` now calls `hide()` first when narrow (marks seen, writes no choice, refocuses the strip). New dock test; it failed on the old `open()` ("expected true to be false") and passes now.
- **Tablet: the scrim covered the strip** (low). The fixed scrim (z 19, inset 0) sat over the unpositioned-z strip, so the "Hide activity" chevron read as static and a click landed on the scrim. The strip takes `z-index: 20` while the overlay shows, so it stays lit beside the panel. `spike.spec.ts`'s 1024 case now reopens the overlay and closes it with a real chevron click; with the class removed it failed on "tl-dock-scrim intercepts pointer events", and it passes with it.

Rejected: none.

Gate: PG exit 0 (lint, typecheck, design 233, bridge-core 447 + 1 skipped, tools 1529, jsdom smoke 30); baseline unchanged; `agent.sh specs/spike.spec.ts specs/activity.spec.ts specs/accounts-single.spec.ts` exit 0, 11 passed (10.5m), tablet and phone both green. Sandboxes reaped by their own pgid.
