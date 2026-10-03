# Phase 24 — Checkpoint fraction feeds the bar

## What was done

- **The gate records its count.** `awaitCheckpointGate` sets runtime-only `checkpointsLeft` and `checkpointSpan = max(previous span, left)` next to its existing "{n} checkpoints until your funds arrive" narration, through a small `narrateCheckpointsLeft` helper. The narration text is unchanged. Nothing reads these fields except the progress view model, so the gate is still the only thing that decides arrival.
- **Crossing's share from the count.** `syncProgress` still prefers the deposit-time block snapshot. Without one, and with a span above 0, it returns `{ current: span − left, target: span }`. `depositL2Block` has not been written for new records for a long time, so this fallback is the path that actually runs.
- **Review fix.** The sweep reports only blocked messages, so a counted wait ended one checkpoint short, and a single blocked reading never moved the bar at all. When the gate passes after counting (`markCheckpointsPassed`), the runtime now shows 0 left. Each runtime field has its own doc.

## Tests

- `useBridgeJournal.stages.test.ts`: the gate reads anchors 3, 1, 2, 4, 5 against checkpoint 5. The recorded `[left, span]` runs `[2,2] → [4,4] → [3,4] → [1,4]` and ends `[0,4]` once the gate passes. A reading that rises pins the span as the widest wait seen, not the first one.
- `bridge-steps.test.ts`: Crossing's share from checkpoints is `{0,3,0}` at the start and `{2,3,2/3}` two in. A span of 0 gives no share, and a block snapshot beats the count (`{101,103,1/3}`).

## Attempts and notes

1. The stages test first ran on a `schema: 2` record with no fuel, which never reached `messageReadiness`, so the gate never ran. The default fixture schema works.
2. The first tour's crossing samples read 50 → 58 at "1 checkpoint" → still 58 at "message arrived" → 67 when Crossing was done. That was the reviewer's Medium 1, seen in the harness before the fix. After the fix: 50 → 50 ("2 checkpoints") → 58 ("1 checkpoint") → 67 ("message arrived") → 67 when done. Crossing now reads full before the claim starts. The overall bar still caps a live phase below its whole slot.
3. The phase 24b working-tree edits (`BridgeStepper.vue`, its test, `testids.ts`) were copied aside and restored from a scratch copy while the gate ran on the committed state. No stash was used.

## Deviations

None in code. The fix commit adds `markCheckpointsPassed`, which the plan did not name. It is the same runtime-only field, written when the gate passes.

## Validation gate

- **PG:** `bun run lint` exit 0 (the pre-existing warning and two infos; complexity-baseline OK); `bun run typecheck:all` exit 0; `bun run test:all` exit 0 (design 240; bridge-core 451 + 1 skipped; tools 1577); `bun run --cwd apps/tools test:e2e` exit 0 (30); baselines exit 0.
- **Browser:** `agent.sh specs/deposit-token.spec.ts specs/deposit-token-gas.spec.ts specs/spike.spec.ts` exit 0, **20 passed** (28.9m).
- **After the review fix:**
  - PG: every step exit 0; tools 1577; baselines exit 0.
  - `agent.sh specs/deposit-token.spec.ts` exit 0, **6 passed** (11.9m). This spec exercises the gate the fix touches.
- **Tour (T), `06-inflight` only:** exit 0. `06-inflight` reads 50 % ("Crossing · phase 4 of 6") at every width and theme, with no horizontal scroll. The `06-inflight-crossing-advanced-dark-1440` capture shows the bar at 58 % with one checkpoint left. The phase 23 `06-inflight` captures are kept, because phase 24b re-shoots them with the log.
- **Capture note:** this capture predates the tour's hiding of the parked wallet panel, so the panel's drag bar still shows faintly over the logo at the top left. It is a harness artefact.

## Board comparison (non-decision differences)

1. The board draws Crossing at a single moment, so it has no reference for how the bar moves. The bar climbs in whole-checkpoint steps, and the steps are uneven when the gate's readings jump.

## Independent review

A fresh reviewer read the phase's diff.

Accepted and fixed:
- **Medium: the bar never showed the gate passing.** See What was done.
- **Low: the engine test could not tell the widest span from the first.** It now includes a rising reading.
- **Nit: one doc comment covered both fields.** Each field now has its own.

Recorded, not changed:
- **Medium: the compact rail on Activity cards changes.** `syncProgress` feeds both the stepper and the compact card, as the plan's own step requires. So an in-flight deposit's Crossing cell is now a track with a partial fill instead of a solid signal cell. At the first reading the fill is 0, and the cell looks pending apart from its bold label. Surface 5 of the plan says compact rails are unchanged. This is flagged below, and phase 24b's tour adds a card mid-crossing capture.
- **Low: after a count, a failed readiness probe says "waiting for the message to reach the L2" while the bar keeps its last share.** Keeping the share is right; the text was already there.
- **Nit: an extra, harmless clamp in `syncProgress`.** Kept.

## Flags for owner sign-off

- **The compact card's Crossing cell now fills by checkpoints** (review Medium 2). It starts empty, where it used to be solid signal. It needs adding to arc 8's visible surfaces with a written sign-off, or `syncProgress` needs to feed the stepper only. The phase 23 PROVE anchoring changes the card's PROVE cell the same way: it starts empty, where the old ratio started near full.
