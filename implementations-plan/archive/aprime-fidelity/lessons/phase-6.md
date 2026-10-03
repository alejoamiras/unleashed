# Phase 6 — Step rail and direction segment

## What was done

- **G14 + G15 + G95:** `StepStrip.stateOf` now reads done as `index < completed`; `reachable` stays `index <= completed`, so the step the wizard has unlocked but the user has not passed (Review while on Amount with a valid amount) is todo and still opens on click. A reachable todo keeps `cursor: pointer`; only `aria-disabled` steps take `cursor: default`. The prop doc describes the two readings. A done step with a value renders `.caption` (the step label, 12px ink-3) over `.value` (Mono 700 13, ellipsised) on the vertical rail and the value alone on the horizontal strip; it is raised (`--ul-fill: var(--ul-raised)`), ink, with the 12px check and no hint. `aria-label` stays "Token: USDC". Vertical rail: `gap: 2px 10px` with the marker spanning both text rows, the label at its natural line height (the 28px line is gone), todo labels ink-2 (the base `.step` colour; the ink-3 todo override is deleted), hints ink-3, todo markers square (`--ul-notch: none`) so the 2px inset line is whole.
- **G95 hints + G96 + G97 + G143:** `HINT` is lower case ("what are you sending?", "how much, what arrives", "check it, then sign"). The live caption reads `Step N of 3, <Label>: <caption>`. The segment's basis is 428px. A step change focuses a visually hidden `<h2 tabindex="-1">` holding the step label (`sendStepHeading`, registered in `lib/testids.ts`); the panel keeps `sendStepPanel` and loses its tabindex.
- **Tests:** `StepStrip.test.ts`: the done-value case mounts the vertical rail and reads `.caption` "Token" and `.value` "USDC" (plus the horizontal strip's bare "USDC"); a new case pins active 1 / completed 2 → `["done","active","todo"]`, step 3 not `aria-disabled`, and its click emits `select` 2; the vertical case now expects hints only on steps not done (`[false, true, true]`). `WizardShell.test.ts`: both caption strings; the focus case expects `sendStepHeading`, reading "Amount", `sr-only`, and the panel without tabindex. `testid-coverage.test.ts` adds `[tabindex]` to the swept selector, so every focus target in the send steps must carry a test id; every existing `[tabindex]` element already did.

## Attempts and notes

1. Biome refused the first helper name, `valueOf` (`noShadowRestrictedNames`); it is `doneValue`.
2. The tour's attempt to hold the locked direction segment by holding the review's Permit2 signature failed as a capture: a private send swaps the wizard for the Seal stepper before the signature, so the segment is off screen (the four `05b-review-locked` captures were reviewed and dropped). The backgrounded send in `03d-background-strip` holds the lock instead (`busy` stays true while the background send runs), so the captures do show the locked segment: the selected direction keeps reverse video and the other reads disabled.

## Deviations from the plan

- **Horizontal strip keeps the value alone.** The plan's done markup is `.caption` + `.value`; the caption renders only on the vertical rail, because the Mobile board's horizontal cells draw the value alone and arc 9 styles that strip. The horizontal strip renders nowhere today.
- **Todo label colour changed on both orientations** (ink-2), not only the rail: both boards draw todo labels #B4B4AF, and the old ink-3 override was the only rule.
- **`testid-coverage.test.ts` registers the heading by sweeping `[tabindex]`** rather than by naming it, so a future focus target without a test id fails the same sweep.

## Validation gate

Run (`impl/pg6.sh`, `impl/e2e6.sh`, concurrently; each command's exit code logged):
- PG: `bun run lint` exit 0 (complexity-baseline OK; the one warning and two infos are pre-existing, in `check-fpc-version.ts`, `private-fuel.test.ts` and `useBridgeJournal.stages.test.ts`). `bun run typecheck:all` exit 0. `bun run test:all` exit 0 (design 217, bridge-core 447 + 1 skipped, tools 1478 in 105 files: one new StepStrip case). `bun run --cwd apps/tools test:e2e` exit 0 (30 tests).
- Baseline: `git diff --exit-code <rev> -- scripts/complexity-baseline/manifest.json` exit 0; the same from the plan base exit 0.
- `bash apps/tools/scripts/e2e/agent.sh specs/deposit-token.spec.ts specs/fee-states.spec.ts` exit 0: `12 passed (15.8m)`, no retries.
- T (arc 2): `specs/zz-arc2.spec.ts` alone through `agent.sh`, exit 0 (`1 passed (2.3m)`), then deleted. 36 captures: 03-token, 03c-lookup, 03d-background-strip, 03e-token-exit, 04-amount, 05-review, dark and light at 1440, 1100 and 390. The spec's per-capture report: step states read `active,todo,todo` on the token step (both directions and the background strip), `done,active,todo` on Amount and `done,done,active` on Review at every width; the segment measures 428px at 1440 and 1100; no horizontal scroll at any width. Focus was on `sendStepHeading` after Continue.

## Board vs capture

Checked against DCQBridgeToken, DCQBridgeAmount and DCQAmountLight:
- Matches: done step raised with the carrier-bg marker and 12px check, caption over Mono value, no hint; active step signal-tint with ink hint; todo steps square outlined markers, ink-2 label, ink-3 hint; lower-case hints wrapping as the board wraps them in the 168px rail; Review is todo on Amount (the G14 bug is gone at 1440, 1100 and 390, both themes); segment 428px.
- **Light caption colour (flag):** the plan sets the done caption to ink-3 in both themes. DCQAmountLight draws it #48464F (light ink-2); dark matches (#8C8C93). Light ink-3 #65636e on the raised fill is a pinned ≥ 4.5 pair, so this is a tone difference, not a contrast one. Following the light board needs a theme-specific rule or a new token.
- **Light board's rail metrics** (padding 10, gap 12, Mono 15 value) are not followed: OQ32 A takes only the light board's colours.
- **Failed background strip:** not reachable in the harness; the amber dot is covered by `SendWizard.test.ts`.
- Differences owned by later arcs, not fixed here: amounts not padded ("250", "1000", arc 5 OQ3), the rail Activity count and dock (arcs 3–4), the footer (arc 7), the review fee note layout (arc 7), and the 390 wizard still stacking the vertical rail (the horizontal strip is arc 9, G18).
- Pre-existing harness artefact: the hidden test-wallet frame leaves a grey box over the rail's top-left corner, as in the arc 1 captures.

## Flags for owner sign-off

- Light done caption ink-3 vs the light board's ink-2 (above).
- Review now reads todo while the user is on a valid Amount step: clicking it still opens Review, but a check appears only on steps behind `completed` (Token and Amount), never on Review itself.
- The step change now moves focus to a hidden heading; nothing visible changes, but screen readers hear the step name before the content.
