# Phase 23 — Stepper chrome

## What was done

- **`DirectionSegment.vue` extracted.** A pure move out of `WizardShell.vue`: the roving tablist, `pick()`, `onArrow()` and the segment styles, with `WizardShell.test.ts` unchanged. PG passed on this commit alone before anything else landed.
- **A locked copy for the stepper.** An optional `testids` prop replaces the send's ids; buttons without an id in it get none, so the stepper's copy carries only `tl-stepper-direction` and `pages/send.ts`/`pages/exit.ts` never click a disabled copy. `pick()` and `onArrow()` refuse while locked. `testids.ts` gains `stepperDirection` and `stepperProgress`.
- **`overallProgress(phases)`.** `(done + live share) / total`, where the live share is the live or failed phase's `progress.fraction`, capped at 0.99 so the bar reaches 1 only when every phase is done (that is, on `completedAt`). `index` is the live phase's 1-based position; `state` is `failed` when the live phase failed, `done` when all are. It is derived per render, never smoothed, so a retry back to Crossing lowers it.
- **`--ul-notch-4-bottom`.** Square on top, `--ul-notch-4`'s bottom steps below; the design README names it.
- **The stepper in three regions, per G10, G56, G125 and G126.**
  - Locked row, padding 20 24 0: the locked `DirectionSegment` (flex-basis 380 as the board draws it) and "Direction is locked while this send runs" (13, ink-3). The row wraps, so the note drops under the segment on phones.
  - Body, padding 24 and gap 22: `section aria-labelledby` → `h2` "Bridging" via `useId`; the subline as spans, the amount and symbol in a Mono ink span; Backup at 40 tall, padding 0 14, gap 8, the `save` glyph at 12, the shipped title kept; a caption row, "{live phase} · phase n of N" left and Mono "m:ss elapsed" right; the phase list.
  - Band: a `.ul-notch` host on `--ul-raised` with `--ul-notch-4-bottom`, holding "Run in background" (600, 40 tall, dotted underline offset 5) and its hint inline; rendered only when `canBackground`.
  - `startedAt?` defaults to `record.createdAt`. `SendWizard.vue` stamps `sendStartedAt` in `onConfirm` just before it dispatches to `runSend`/`runExit`, and passes it to both stepper mounts, so the clock runs on across the permission prompt's hand-over. The clock stops at `completedAt`.
- **The shared `ProgressBar`.** The component is a patch-identical cherry-pick of arc 6's (the same patch id, `186e45d5…`), so a rebase onto arc 6 drops it on its own. The stepper passes `value = overall.fraction`, height 18, label "Bridge progress", `aria-valuetext` "{percent} percent, {live phase}", tone `lost` when failed and `carrier` when done, and steps the fill's width in `360ms steps(6)` through `:deep([role="progressbar"] > span)`. Reduced motion lands it at once through `base.css`.
- **Review fixes.**
  - PROVE's share now runs from the first proven block seen once the exit's block is known (`RecordRuntime.provenFrom`, set by the engine). `provenBlock / targetBlock` are both absolute L2 block numbers, so the old ratio sat near 1 from the start on any real network and would have frozen the overall bar at half for the whole proof wait. Without an anchor, PROVE shows no share.
  - The headline wraps anywhere, so a 32-character symbol cannot overflow at 390.
  - The locked segment names its reason through `aria-describedby`.

## Tests

- `DirectionSegment.test.ts`: a locked segment keeps its selection, disables both tabs and emits nothing on a click or ←, with `disabled` lifted so test-utils actually dispatches; the same click emits once unlocked. A `testids` override leaves no send testid.
- `testid-coverage.test.ts`: the `DirectionSegment` entry.
- `bridge-steps.test.ts`:
  - `overallProgress` over the private deposit (granting → sealing → approving → signing → depositing → syncing → claim → confirm): strictly rising, index and total per step, below 1 until `completedAt`, exactly 1 with `state: "done"` after.
  - A failed Claim keeps its position; a failed Crossing keeps its 2/3 share; a retry back to Crossing lowers the fraction to that attempt's value.
  - A finished sync never fills its slot.
  - PROVE with realistic block numbers: share 0 at the anchor, 0.5 halfway, none without an anchor.
- `useBridgeJournal.stages.test.ts`: the engine anchors `provenFrom` on the first proven block after `targetBlock` and keeps it.
- `BridgeStepper.test.ts`:
  - The bar's role, name, `aria-valuenow`, value text and tone, with the caption: "Seal · phase 1 of 6" at 0; "Crossing · phase 4 of 6" at 61 with two of three blocks in; "Crossing failed · phase 4 of 6" at 50, lost; "Done · phase 6 of 6" at 100, carrier.
  - "2:40 elapsed" from a given `startedAt`, "0:14" from `createdAt`, and "1:00" frozen at `completedAt`.
  - The locked row: both tabs disabled, the record's direction selected for a deposit and for a withdraw, no `tl-send-direction`, the note linked by `aria-describedby`.
  - No band and no background button when `canBackground` is false.
  - The heading is an `h2` that names the section.
  - The headline's text and its Mono amount span; Backup draws `save`.
- `SendWizard.test.ts`: the permission stepper and the record's stepper receive the same `startedAt`.
- `base-css.test.ts`: `--ul-notch-4-bottom` is `polygon(0 0, 100% 0, …)` followed by notch-4's ten bottom points.

## Attempts and notes

1. arc 6 had not committed `ProgressBar` when the stepper was restructured, so that commit shipped the caption without the bar. By the time the bar was due, arc 6's existed; I cherry-picked it with `--no-commit` and committed it with the same message, so its patch id matches and a rebase drops it. Nothing of arc 6's was rebuilt here.
2. The first tour injected a `sendTx` failure into a first-time token's registering claim and then pressed Retry. The retry never reached a receipt: the engine held the run on "fuel claim attempt pending — waiting for its receipt before retrying". The failed-phase capture is now the tour's last step, on a registered token, and nothing waits on its retry. This is the engine's existing guard, not a change here.
3. The sandbox proves an exit at once, so PROVE is active for well under a second. The tour parks the exit on its L1 transaction instead (`l1.holdNext("transaction")`), which shows FINISH with the locked "Aztec → Ethereum" row. PROVE's anchored share is proven by the unit tests only.

## Deviations

- **The locked segment is 380 wide in the stepper** (the board's width); the wizard's stays `flex: 0 1 428px`.
- **"Done · phase N of N"** is the caption and value text once every phase is done. The plan names only the running and failed forms.
- **The failed caption reads "{phase} failed"** for any phase, as the plan's Crossing example does.
- **The width transition is set from the stepper through `:deep`**, because `ProgressBar` has no transition prop. A change to its markup would drop the stepping silently (review nit 5, recorded).
- **The elapsed clock stops at `completedAt`** rather than counting on.

## Validation gate

- **PG:** `bun run lint` exit 0 (the pre-existing warning and two infos; complexity-baseline OK); `bun run typecheck:all` exit 0; `bun run test:all` exit 0 (design 240; bridge-core 451 + 1 skipped; tools 1574 in 107 files); `bun run --cwd apps/tools test:e2e` exit 0 (30 tests); baselines exit 0.
- **Browser**, each in its own sandbox, in place of the full `e2e:tools`:
  - `agent.sh specs/deposit-token.spec.ts specs/deposit-gas-only.spec.ts specs/activity.spec.ts specs/spike.spec.ts`: exit 0, **24 passed** (32.8m).
  - `agent.sh specs/deposit-token-gas.spec.ts specs/exits.spec.ts`: exit 0, **14 passed** (26.4m).
- **After the review fixes:**
  - PG: typecheck, test:all (tools 1575) and test:e2e exit 0; baselines exit 0.
  - `bun run lint`: the first run exited 1 on the formatting of the untracked tour spec, not on committed code. Once that spec was formatted, it exits 0.
  - `agent.sh specs/exits.spec.ts`: exit 0, **7 passed** (16.3m). The fix touches the exit's progress path.
- **Tour (T):** the spec ran (exit 0) and again for the exit alone (exit 0). 29 captures were taken: `06a-permit`, `06-inflight`, `06-inflight-failed` and `06-inflight-exit` in dark and light at 1440, 1100 and 390; `06-inflight-private` at 1440 and 390; `06-inflight-later` at 1440 dark. Every capture reports no horizontal scroll, and the stepper never scrolls on its own (358 wide at 390).

## Board comparison (non-decision differences)

1. **Done rows read "0:00" and the permission row has no time.** In the sandbox, Authorize and Deposit are over before the stepper's first tick. The permission phase's clock was keyed on the provisional record, and the journal's record starts a new one. The board shows real durations. This is the phase 22 clock, honestly reported.
2. **The page footer (Foundry and Aztec links) still shows under the in-flight card.** Arc 7 removes it from in-flight.
3. **At 390, the subline breaks between amount and symbol** ("174.20 / FRSH · public"). The board has no phone in-flight capture.
4. **The Log panel beside the list is not there yet.** Phase 24b adds it.
5. **Some runtime copy is pre-existing and not board copy:**
   - FINISH's lowercase detail, "waiting for the proven epoch, then one Ethereum confirmation".
   - The failure note ending "Your funds are not lost - retry from this card." It sits on the stepper, not a card, and has a hyphen dash.

## Independent review

A fresh reviewer read the phase's diff.

Accepted and fixed:
- **Medium: PROVE's share was meaningless on a real network.** It is now anchored (see What was done).
- **Low: the locked-click test could not fail.** It now reaches the guards.
- **Low: a long symbol could overflow the headline.** `overflow-wrap: anywhere`.
- **Nit: the failed-share claim was untested.** A failed Crossing at 2/3 is now pinned.
- **Nit: the `index` doc did not cover "none live".** It does now.
- **Nit: the locked note was not linked to the tablist.** `aria-describedby`.

Recorded, not changed:
- **Low: the receipt counts from `createdAt` while the stepper counts from the confirm.** Surface 5 keeps the receipt unchanged. Flagged below.
- **Nit: the `:deep` transition depends on `ProgressBar`'s markup.** Recorded under Deviations; a prop belongs to the design package's owner (arc 6).
- **Nit: the direction labels repeat in `BridgeStepper` and `DirectionSegment`.** Two short strings; a shared module for them would cost more than it saves.

## Flags for owner sign-off

- "Done · phase N of N" and the value-text wording "{n} percent, {phase}".
- The receipt's duration (from `createdAt`) and the stepper's clock (from the confirm) can differ by the permission prompt and the signatures before the record exists.
- The locked segment's 380 width in the stepper against 428 in the wizard.
- The pre-existing runtime copy in Board comparison 5.
- **Dependencies:** arc 6's `ProgressBar` (cherry-picked, drops at rebase) and `formatClock` (the phase 22 stand-in, to drop at rebase). Arc 7 removes the page footer under the in-flight card.
