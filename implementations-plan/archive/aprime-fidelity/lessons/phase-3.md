# Phase 3 — Tags, busy and destructive primitives

## What was done

- **Step 1 (G34):** `Tag` has one tone table (`neutral ink testnet warn lost carrier private other`), an `icon` prop (`IconName | null`; `undefined` keeps the tone's default, `null` drops it) and `size="small"` (24px, padding 0 8, 12px). Default icons: warn warning-diamond, lost square-alert, carrier check, private eye-off, other wallet; neutral, ink and testnet have none. `ink` is the raised fill with ink text (the board's "Proving" and gas chips). The lilac `test` tone is gone. `DisclaimerTag` is `tone="neutral" icon="info-box"`; the mint strip's chip is `tone="testnet"` (amber, no icon, OQ31 A).
- **Step 2 (G35):** `BusyPixels` (three 6px squares, gap 3, `currentColor` at 1/.55/.2, `role=status` labelled "Loading" by default, pixels `aria-hidden`). The lit pixel steps right one 90ms tick at a time (a 270ms `steps(1, end)` cycle, two negative delays). The animation exists only under `prefers-reduced-motion: no-preference`, so reduced motion shows the static 1/.55/.2 frame without depending on the global override. `Button` renders its slot, then `<BusyPixels v-if="loading">`; a loading primary takes `--ul-signal-tint` with `--ul-accent-text` (a contrast pair already pinned in both themes). `Spinner.vue` and its test are deleted, `index.ts` exports `BusyPixels`, and the stale mentions (the `theme-contrast.ts` comment, plus the `theme-vars.ts` example and the `design-resolver.ts` list) no longer name Spinner. Busy labels lost their ellipsis.
- **Step 3 (Fact 5):** `Button` declares `click: [event: MouseEvent]` and re-emits it from the native button only while neither `loading` nor `disabled`. A native button turns Enter and Space into `click`, so this also covers the keyboard. `aria-busy` stays. The waiting "Approve in your wallet" button (`AztecWalletPanel.vue:114`) gains `disabled`. Every other `loading` site already binds `disabled` or is a `DripButton` (checked by grep: AztecWalletPanel connect, L1WalletPanel, BridgeJournal restore, BridgeJournalCard claim gas, BridgeReceipt add token, TokenCard add token, ReviewStep confirm). DripButton's comment now says why it still disables on `loading`. `.loading { pointer-events: none }` stays, commented as cosmetic.
- **Step 4 (G36):** destructive fill `--ul-lost-bg` with `--ul-lost` text, no inset edge (the now-dead `:disabled::before` override went with it); "Confirm discard" leads with a 12px `close` glyph, placed before the label as the Components board draws it.
- **Step 5:** `packages/design/README.md` documents the 12/24 icon grid, the tone table, `BusyPixels` and the loading guard.
- **Tests:** `Tag.test.ts` (one `it.each` over the eight tones → class and default glyph, compared path for path with `ICONS`; one override/null; one small; slot and test id kept in one case). `DisclaimerTag.test.ts` asserts `.tag--neutral` and the info-box paths. `BusyPixels.test.ts` replaces `Spinner.test.ts` (three pixels, labelled status, default label). `Button.test.ts`: the status follows the label in DOM order and there is no spinner svg; a new case sends two clicks plus Enter and Space keydowns to a loading button, expects no `click`, then clears `loading` and expects exactly one. `AztecWalletPanel.test.ts` asserts `disabled` on the waiting button. `mount-all.test.ts` mounts BusyPixels. Design suite 217 tests (213 before, −4 Spinner +1 BusyPixels +1 Button +6 net Tag).

## Attempts and notes

1. The first Button DOM-order assertion read `firstChild`. Vue's fragment anchor puts an empty text node first, so it failed (`expected '' to be 'Sending'`). It now finds the "Sending" text node and asserts `compareDocumentPosition(status) === DOCUMENT_POSITION_FOLLOWING`, which fails if the pixels come first.
2. The first tour run exercised three flows that did not hold. (a) A held Permit2 signature did not keep the review's "Sending" state on screen. The confirm button left the DOM as soon as the send adopted its record. The step was dropped, since the gate asks only for a busy drip. (b) A post-capture reload waited for a journal card on a route that does not show it. The capture had already been taken; the wait was removed. (c) After `page.goto("/")` the faucet panel never reconnected, so the drip buttons stayed disabled. The spec now reconnects through the bridge panel (one shared connection) and switches tabs. The second run passed.

## Deviations from the plan

- **A seventh ellipsis removed:** "Searching for wallets…" (`AztecWalletPanel.vue:67`) is also a `Button` `loading` label (status `discovering`). G35's change column says "drop ellipses on Button-`loading` labels", but its list names six. Only its unit test reads it, with `toContain("Searching for wallet")`.
- **Two stale comments beyond the one the plan names:** `theme-vars.ts` used `<Spinner color=…>` as its example of a token-name prop (now `<Icon color=…>`), and `apps/tools/scripts/design-resolver.ts` listed Spinner among explicitly imported components. Both named a deleted component.
- **Busy gap:** the board puts 12px between label and pixels. The button keeps its size gap (8 medium, 10 large, 6 small). Not in the step list; 2–4px.

## Validation gate (LG for PR 1)

`bash impl/gate3.sh` (each command's exit code logged):
- PG: `bun run lint` exit 0 (complexity-baseline OK; the one warning and two infos are the pre-existing `noDelete`/unused-import notes in bridge-core and `useBridgeJournal.stages.test.ts`). `bun run typecheck:all` exit 0 (design, bridge-core, tools). `bun run test:all` exit 0 (design 217, bridge-core 447 + 1 skipped, tools 1480). `bun run --cwd apps/tools test:e2e` exit 0 (30 tests).
- Baseline: `git diff --exit-code <rev> -- scripts/complexity-baseline/manifest.json` exit 0. The same diff from the plan base is empty.
- BG: `build:testnet`, `verify:build-target testnet`, `build:mainnet`, `verify:build-target mainnet` each exit 0; no `data:font` in either `dist`; `diff "$SCRATCH/headers-<t>" apps/tools/dist/_headers` exit 0 for both; `verify:deployments` exit 0.
- `bun run audit:tools` exit 0 (tools 1480 tests, lint, deployment check, testnet build).
- `bun run e2e:tools` exit 0: `69 passed (1.7h)`, one worker, no retries, no failures, no zz spec present.
- T: `agent.sh specs/zz-arc1.spec.ts` exit 0, `1 passed (3.1m)`, run alone. The spec was deleted afterwards and never committed. 18 JPEGs. New: `08b-discard-armed` (arm, shoot, no confirm) and `09b-faucet-busy-drip` (private drip, shot right after the click, `aria-busy` asserted). Replaced: `03-token` (the amber Testnet chip), `04-focus-continue` (Continue reached by Tab, `:focus-visible` asserted) and `09-faucet` (the neutral disclaimer). All in dark and light, at 1440 and 390; focus at 1440 only. None of the 18 captures shows a board.

## Board vs capture

- **Busy drip** (Faucet board, the first faucet token's private drip button, busy): tint fill, magenta label, three pixels after it, matching the board in both themes. Our label keeps its idle text, as the board does.
- **Testnet chip** (BridgeToken): amber, no icon, 28px, now as the board draws it. The strip's own anatomy (48px, left aligned, download icons, well fill) is arc 2.
- **Disclaimer** (Faucet): neutral grey with the info glyph now. Its position (the board puts it in the header row) is G22, arc 6.
- **Confirm discard** (Components): lost fill, red text, no edge, × before the label. The card around it is arc 4.
- **Focus ring:** unchanged from phase 1 (ink, 3px off).
- Harness artefacts as in phase 2: the grey box over the rail's top-left corner (the hidden test-wallet frame's container). The busy pixels are captured mid-cycle, so the lit pixel is not always the first.

## Flags for owner sign-off

- Non-primary busy buttons keep their variant fill (secondary raised, destructive lost): the board draws only a primary busy button. Captured: `09b` shows the primary; no secondary busy state is captured.
- The board's `cursor: progress` on busy buttons is not used (D13): `pointer-events: none` stays, and a cursor needs pointer events.
- The label-to-pixels gap stays at the button's size gap (8/10px), not the board's 12px.
- "Permissions denied — try again" and the connect error use the new destructive fill but no test wallet profile refuses capabilities, so neither is captured; `08b` shows the same variant.
- The review's busy "Sending" state is not captured (see attempt 2a); it uses the same primary busy style as `09b`.

## Codex post-implementation review, round 1 (PR layer 1)

Six Low findings, no High or Medium; all six verified against the code and accepted.

- The keyboard half of the loading-guard test proved nothing (jsdom never synthesises activation clicks): the keydowns are gone and the test is named for what it proves. Keyboard activation in a browser still arrives as a `click`, which the guard drops.
- `BusyPixels` inside `Button` is `aria-hidden`, so a busy button's name is its label alone; `aria-busy` carries the state. Standalone `BusyPixels` keeps its labelled `role=status`.
- `ActivityRow`'s `.amt` override (2px) is deleted; it inherits the global 3px offset.
- The Icon TSDoc, the design README and the plan no longer claim 12px lands on whole device pixels (odd path coordinates sit on half pixels at DPR 1).
- G35 now describes the implemented 270ms cycle of three 90ms holds, not `--ul-tick`.
- Comment tightening: BusyPixels, DripButton (the `data-loading` narration), Tag (the unenforced colour claim).

Gate: PG exit 0 (design 217, bridge-core 447 + 1 skipped, tools 1480, smoke 30).

Round 2 (fix diff): material findings 0. Codex confirmed `aria-hidden` on the hidden status element is valid (nothing focusable inside) and nothing depended on the 2px offset.
