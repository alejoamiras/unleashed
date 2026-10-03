# Phase 22 — The phase list and its data

## What was done

- **A stand-in `formatClock`.** `formatClock(ms)` in `phase-clock.ts` returns whole-second clock time: "0:04", "2:40", "1:02:05". The plan builds it in phase 18 (arc 6, the faucet's proving panel), which runs concurrently on another branch. This commit carries the same interface and the plan's four test values, and touches only `phase-clock.ts` and its test. **Drop it when this branch is rebased onto arc 6**; the conflict is confined to those two files.
- **Estimates.** `BridgePhase.estimate` is attached by `buildPhases` to pending phases only, from two tables:

  | Rail | Phase | Estimate |
  |---|---|---|
  | Deposit | Deposit | ~1 min |
  | Deposit | Crossing | ~1–4 min |
  | Deposit | Confirm | ~1–2 min |
  | Withdraw | Prove | tens of min |
  | Withdraw | Confirm | ~2 min |

  Signature phases (permission, seal, approve, authorize, register, claim, exit, finish) get none. `eta` is unchanged and still feeds the background strip.
- **G128.** The static Crossing prompt is the board's sentence, "Aztec picks up deposits every few blocks. Nothing for you to do." The live checkpoint count still replaces it through `stepDetail`.
- **The full rail, per G55 and G126.** The list half only; the bar and the stepper chrome are phase 23.
  - The spine, the pulse and its keyframes, the full branch's per-phase sub-bar and its count are gone, along with the reduced-motion rule that only stopped the pulse.
  - Rows are flex, gap 12, min-height 34. The glyph column is 12px wide and 20px tall, the label's line height, so the glyph and the time sit on the label's line when a detail stacks below it.
  - The active phase's glyph is a still 12px square with an sr-only "in progress". A landed CONFIRM recolours it carrier.
  - The time cell shows `formatClock(elapsedMs)` on done rows (ink-2), `formatClock(now − startedAt)` on the live row (accent text), and the estimate on pending rows (ink-3).
  - The active row keeps its tint, notch and bleed (`margin: 2px -10px`, padding 10). The label and detail stack in a column with gap 4, and the detail is 13/1.4. Retry sits in the same column under the detail.
  - `ol aria-label="Phases"`; the active or failed `li` carries `aria-current="step"`.
  - `data-phase`, `data-state`, `stepperPhase`, `sendStepperRegister` and `stepperRetry` are unchanged. The compact branch is unchanged.
- **G94, in-flight half.** " - " → " — " in the two `deposit-flow.ts` refusals the plan names (the private gas read failure and the "holds none at the fee contract" stop). `exits.spec.ts:277` matches a substring either side of the dash.

## Tests

- `phase-clock.test.ts`: the four `formatClock` cases.
- `bridge-steps.test.ts`:
  - The SYNC case asserts the exact `eta` ("usually 1-4 min"), the board sentence as the fallback detail, and the live checkpoint count replacing it.
  - A new case: estimates on pending chain phases only, none on signature phases or the live phase, for both rails; the exit's `eta` unchanged.
  - A new case (from the review): a failed run and a blocked record carry no estimate.
- `BridgePhaseRail.test.ts`:
  - The first full-rail case now proves: the list is named "Phases"; exactly one row is `aria-current="step"`; the live row reads "0:05" five seconds in, and never "usually 1-4 min"; no progressbar and no "102 / 103" count; the pending Confirm reads "~1–2 min"; the Claim row has no time cell.
  - A failed phase is `aria-current="step"` and keeps its note.
  - "14s" → "0:14".
  - The landed CONFIRM is a `.square.landed` whose glyph cell reads "in progress".
  - Both motion checks now look for any retired motion class (`pulse`, `stamp`, `spin`, `blink`) on any element.

## Attempts and notes

1. Biome reformatted the deposit `buildPhases` call into ten lines once the estimates table was added. A `completed` local keeps it on one line.

## Deviations

- **`formatClock` floors to whole seconds.** The plan names only the four outputs; flooring keeps a live clock from showing the next second early.
- **The sr-only state word sits in the glyph cell**, before the label, as the icons' `label` already did, so every row reads "state, label". The board puts ", done" after the label.
- **Failed rows get the same stacked layout as the live row, without the tint.** The board draws no failed row.
- **The dash sweep stops where the plan stops.** The review noted other " - " strings on the same claim path (`deposit-flow.ts` 580–581, 629–630, 657–658, 685–686, 691–692) and in the rail's prompts (`bridge-steps.ts`, e.g. "Confirming on Aztec - no signature needed.", "Proven block n of m - lands in epoch batches."). No phase's G94 list names them. Flagged for the owner rather than widened.

## Validation gate

- **PG** (the phase's last code commit before review):
  - `bun run lint`: exit 0 (the pre-existing warning and two infos; complexity-baseline OK).
  - `bun run typecheck:all`: exit 0.
  - `bun run test:all`: exit 0 (design 236; bridge-core 451 + 1 skipped; tools 1563 in 106 files).
  - `bun run --cwd apps/tools test:e2e`: exit 0 (30 tests).
- **Browser:** `agent.sh specs/deposit-token.spec.ts specs/exits.spec.ts` in its own sandbox: exit 0, **13 passed** (26.6m), none flaky. The run stopped its own sandbox by pgid.
- **Baselines:** `git diff --exit-code <rev> -- scripts/complexity-baseline/manifest.json` exit 0.
- **PG re-run** (the review fixes): lint, typecheck, test:all (tools 1564) and test:e2e all exit 0; baselines unchanged. The fixes change no attribute the browser specs read (`stepperPhases()` reads only `data-phase`/`data-state`), so the browser run was not repeated.

## Independent review

A fresh reviewer read the phase's diff against the plan and the board. It found no high or medium defects.

Accepted and fixed:
- **Low: light-theme contrast of the live square.** `--ul-signal` on the light tint is about 2.3:1. The square now uses `--ul-accent-text`, which equals signal in dark.
- **Low: estimates on a run that will not continue.** A failed attention or a persisted block now drops every pending estimate (`buildPhases` and `failBlocked`), so a stalled send never promises a duration.
- **Low: the motion test checked one class that no longer exists.** It now checks every retired motion class.
- **Low: long unbroken notes overflowed the row.** `.phase .detail` wraps anywhere.
- **Nits:** the `timeOf` comment that restated its body is gone; the `landed` doc says "live phase", not "dot".

Recorded, not changed:
- **Low: the uneven dash sweep.** It follows the plan as written; see Deviations.
- **Low: this lessons file and the ✓.** This file is the fix.

## Flags for owner sign-off

- The short estimates are new copy on pending rows.
- The remaining " - " strings on the claim path and in the rail prompts (Deviations).
- The phase list's look is proved by the arc 8 tour in phase 23; this phase changed no layout outside the list.
