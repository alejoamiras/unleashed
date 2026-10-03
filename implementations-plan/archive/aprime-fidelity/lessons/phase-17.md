# Phase 17 — Balances, buttons, add-to-wallet, success strip, lock reason

## What was done

- **Balances.** `D:composite/BalanceRow.vue` is a column (gap 4) of two 40px raised notch-2 rows, public first: a 12px glyph (`eye` in ink-2 for public, `eye-off` in `--ul-accent-text` for private), the label "Public"/"Private" at 14 ink-2 growing to fill, and the value in Mono 400 15 ink at the right. The value testids stay on the value spans; the "wallet convention" comment is gone (G20, OQ25 A).
- **Drip buttons.** `D:composite/DripButton.vue` always renders the large `Button` (48px, 16px, gap 10) and takes an optional `icon`, drawn at 24px before the label while idle and dropped while loading, where the busy pixels follow the label instead (G19).
- **Token card.** The two drip buttons stack full width in a column (gap 8), private first with `eye-off`, public with `eye`. `lockedBy` reads the global `drip.inflight` and is the running token's symbol only when it is another card's; while it is set, a `<p>` (13/1.45 ink-2, `tl-drip-lock-reason`) reads "One drip at a time: the {SYMBOL} drip is still running." under the buttons, and both buttons' `aria-describedby` point at its `useId()` id (G84; `useDrip.ts`'s guard is unchanged). "Add {SYMBOL} to wallet" leads with `plus` 12; a scoped `.add-to-wallet-btn` sets padding 0 4 and gap 8, which outranks the Button module's `.small` (G83). The status element keeps `tl-drip-status` and `data-drip-status` in every state and gains `role="status"`, 14px text and gap 10. Its ok state is markup: a carrier `check` 12, "Sent **{amount} {SYMBOL}** to {target}" with the figure in Mono 700 14, and "View tx" 14/700 with `external-link` 12 on the right. `statusLabel` keeps only the dripping and error strings.
- **Testid:** `dripLockReason: "tl-drip-lock-reason"` in `lib/testids.ts`.

## Tests

- `BalanceRow.test.ts`: the labels read "Public" then "Private" with one svg per row (was "Balance · public/private"); values render public first (was private first). The other five cases are unchanged.
- `DripButton.test.ts`: one case, the button is large, draws its 24px icon while idle and none while loading (label unchanged).
- `TokenCard.test.ts`: `:151-160` also asserts `role="status"` and the text "Sent 1,000 SIGNAL to public"; a new case: no reason and no `aria-describedby` at rest; NOISE in flight ⇒ the SIGNAL card shows "One drip at a time: the NOISE drip is still running." and both (disabled) buttons reference its id; SIGNAL's own drip ⇒ no reason.
- `specs/drip.spec.ts` unchanged.
- Verifier follow-up: the lock-reason case also checks that both buttons drop `aria-describedby` once the running drip is this card's own.

## Attempts and notes

1. `.add-to-wallet-btn` compiles to `.add-to-wallet-btn[data-v-…]` (0,2,0) against the Button module's `.small` (0,1,0), and the Button's root carries the card's scope id, so the override holds whatever order the sheets load in (checked by the verifier with `@vue/compiler-sfc`).
2. `aria-describedby` is not a DripButton or Button prop, so it falls through to the native `<button>`; the unit test mounts the real components, so it proves that path.
3. "Added" (check 12) is unreachable in practice, as it was before this phase: on `ok` the card sets `registered` and the whole add-to-wallet row unmounts in the same tick. Left as is (behaviour, not look).

## Deviations from the plan

- **`role="status"` sits on the one status element in every state** (dripping, ok, error), not only on the success strip. The element and its testid are shared across states (G83's note), and G138 asks for status panels with the role; phase 18's proving panel is the same element.
- **The lock reason's style** (13/1.45 ink-2, under the buttons) has no board: the board draws the other card enabled.

## Validation gate

Run, and PG again after the verifier's low fixes (same counts):
- `bun run lint` exit 0 (the pre-existing 1 warning and 2 infos; complexity-baseline check OK).
- `bun run typecheck:all` exit 0.
- `bun run test:all` exit 0 (design 237; bridge-core 451 + 1 skipped; tools 1564 in 106 files).
- `bun run --cwd apps/tools test:e2e` exit 0 (30 tests).
- Baselines: `git diff --exit-code <rev> -- scripts/complexity-baseline/manifest.json` exit 0.
- `agent.sh specs/drip.spec.ts` exit 0: 4 passed (3.0m) on the plain, selfpay and full profiles (drips land; add-to-wallet fails open to `unsupported`; `ok` on full removes the button). The run stopped its own sandbox by pgid.

## Verifier

A fresh general-purpose reviewer read the plan, the board and the diff, compiled the scoped styles, and measured the success strip in headless Chromium with the repository's fonts. No high or medium findings. It judged `role="status"` on every state right: one element must exist before its content changes for the dripping → ok announcement to be heard, and G138 names status panels in the plural.

- **Low, accepted:** DripButton's doc said the busy pixels stand in for the icon; they follow the label. Reworded.
- **Low, accepted:** at 390 the SIGNAL success strip wraps to two lines (text column 186px; NOISE's stays on one). `.sent` is now `white-space: nowrap`, so "1,000 SIGNAL" never splits; the two-line strip at 390 stays and is flagged.
- **Low, accepted:** the lock-reason test did not check that `aria-describedby` leaves the buttons with the reason. Added.
- **Note, recorded:** a drip's success and error are announced twice, by the toast and by the strip. G83 implies it; no change.
- **Note, recorded as a board difference:** on the board, the dripping card's disabled public button has no icon; here it keeps its `eye`, per G19 ("except while loading").

## Flags for owner sign-off

- New copy: "One drip at a time: the {SYMBOL} drip is still running." and where it sits.
- The ok strip at 390 wraps "Sent 1,000 SIGNAL to public" to two lines beside "View tx" (see the arc 6 tour).
- The dripping card's disabled public button keeps its `eye` glyph; the board draws it without one.
- "Added" (check 12) never shows, as before: the add-to-wallet row unmounts on success.
