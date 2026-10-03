# Phase 9 — Picker rows

## What was done

- **G66 + G65 id line, the pure half:** `lib/wallet-name.ts` gains `walletTypeLabel(type: unknown)` and `walletIdLine(id)`. The type maps `extension` → "Extension" and `web` → "Web app" through a `Map` (so `toString` and other prototype names are unknown types, not lookups); any other string reads "Unknown type" with `title = "Self-reported: " + sanitizeWalletName(type, 16)`, omitted when nothing visible is left; a non-string has no title. The id is sanitized to 64 graphemes first, then cut to `id head4…tail4` when longer than nine graphemes; `null` (no id line) when nothing visible is left.
- **G06 + G65 + G66 + G139 in the picker, and the settle window:** each `li` keeps `tl-wallet-picker-row` and `data-wallet-key`/`data-wallet-id` and wraps one full-width `<button>` carrying `tl-wallet-picker-connect` and the aria-label `Connect ‹name› (‹chip label›)`: a 40×40 notch-2 tile (`--ul-well` behind a real icon drawn at 24; `--ul-line` with the `wallet` glyph at 24 in ink-2 as the fallback), a column with the 15px/700 name and a small `Tag` on the panel fill (22px, 12/700 ink-2) over the Mono 12.5 ink-3 id line, and "Connect" 14/700 in `--ul-accent-text` with `chevron-down` at 12 rotated −90°. Rows: padding 12 14, gap 14, list gap 6, hover `--ul-line`. The dialog gains the description line (`<p>` with a `useId()` id, passed as `describedby`, margin-top −6, 14/1.45 ink-2). The collision strip takes gap 12, padding 12 14 and 14/1.45 with its copy byte-identical and stays above the rows, as the board places it. The scanning square was already static (phase 7). `safeIcon`, its allowlist, the 4096 cap and `@error` are unchanged; only their comments now say "generic wallet tile".
- **Settle window:** a `watch` on `[hasCollision, row keys]` (immediate) sets `settledAt = now + 500`; the row's click handler returns while `Date.now() < settledAt`, else calls `selectWallet(key)`.
- **Ring inset:** the scrolling list's inset grows 4 → 5px, the carry-over note from phase 1: the rows are now buttons under the global ring (2px, 3px off).
- **Harness:** `tests/browser/pages/connect.ts` `connectAztec` clicks the row inside `expect(…).toPass({ timeout: 20_000 })` until the row hides (an accepted click closes the picker synchronously), then asserts the verification modal as before. The jsdom smoke's `connectThroughPicker` waits 550 ms before its row click.

## Tests

- `wallet-name.test.ts` +4: both type mappings, "Verified wallet" → "Unknown type" / "Self-reported: Verified wallet", a number → no title, `toString` → unknown; a bidi- and zero-width-laden claim → title stripped and bounded at 16 graphemes plus "…"; a short id whole, a 12-character id cut to `id 7c1e…a4f0`, an invisible-only id → `null`; an id with bidi marks at both ends and in the middle sanitized before the cut (`id abcd…wxyz`).
- `WalletPickerModal.test.ts`: `:97` still reads `.name`; the icon case keeps its `img` checks and now asserts the fallback `svg` on each rejected icon; new cases: the row's `button` is the connect testid, aria-label "Connect Acme (Extension)", id line in its text; a wallet typed "Verified wallet" shows "Unknown type", never "Verified" in the row's text, only in `title`; the collision copy equals today's string exactly; with fake timers, a click 499 ms after a second wallet answers connects nothing and one at 500 ms connects, and a click right after the collision strip appears connects nothing until 500 ms pass. The per-row key case advances past the window first.
- e2e: `pages/connect.ts` retries its row click as above; `answerStop` already re-looks every 500 ms.

## Attempts and notes

1. The jsdom smoke failed 4 of 30 after the guard landed (tests 2–5): `connectThroughPicker` clicked the row in the same flush it appeared, inside the window. A 550 ms wait before the click fixed all four; nothing else in the smoke changed.
2. The new unit cases name their wallet "Acme" rather than use the file's existing `row()` default.
3. The first tour's rail-count recipe (the plan's "start a deposit, press `tl-stepper-background`, wait for `tl-dock-badge`") never produced a badge in 8 minutes: a backgrounded send keeps running and completes on its own (the toast `activity.spec.ts` waits for), so it is never needs-you; and at 1440 a needs-you record auto-opens the dock, which hides the strip badge anyway. A second attempt with a token-only deposit and a held router transaction never showed the stepper. The third used arc 1's discard recipe (token + gas, public, router transaction held, reload, reconnect): the idle record is neither busy nor done, so it is needs-you, and the rail chip appeared. The tour waits for the rail's `.count`, not the dock badge.
4. The first gate run failed `lint` only on the uncommitted tour spec (an unused helper and formatting); the spec was deleted before the gate re-ran and before the e2e shards started.

## Deviations from the plan

- **The settle window also arms at mount** (`immediate: true`), not only on a change. The picker is mounted once at the app root, so this costs nothing in the app and matches the plan's note that the key test "advances past the window first".
- **`connectAztec` retries until the picker row hides**, not until the verification modal shows: an accepted click closes the picker synchronously, while the modal waits on the secure channel, which can outlast a short retry and make a retry click a gone row. The modal assertion that follows is unchanged.
- **The jsdom smoke waits 550 ms** before its row click (the plan names only the browser helper); without it the smoke's four connect tests click inside the window.
- **Type chip height 22px** on a `Tag size="small"` (24px by default), as the board draws it; set locally, the primitive is unchanged.
- **Tour rail count reached through a held router transaction**, not the backgrounded send (attempt 3).

## Validation gate (LG for PR 2)

Run (`impl/gate9.sh`, `impl/e2e9.sh`, concurrently, the tour spec deleted first):
- PG: `bun run lint` exit 0 (complexity-baseline OK; the one warning and two infos are the pre-existing ones). `bun run typecheck:all` exit 0. `bun run test:all` exit 0 (design 231, bridge-core 447 + 1 skipped, tools 1491 in 105 files). `bun run --cwd apps/tools test:e2e` exit 0 (30 tests).
- Baseline: `git diff --exit-code <rev> -- scripts/complexity-baseline/manifest.json` exit 0.
- BG: testnet and mainnet each built, `verify:build-target` passed, no `data:font` in `dist`, `_headers` identical to the base's; `verify:deployments` exit 0 ("All committed addresses match the rebuilt instances").
- `bun run audit:tools` exit 0.
- `bun run e2e:tools` as six concurrent shards: every shard exit 0, e2e:tools (6 shards) 69 passed (17 + 7 + 17 + 6 + 11 + 11; 30 min wall clock). Every spec connects through `connectAztec` or `driveToConnected`, so each Aztec connect went through the settle window and the retried row click. Each shard stopped its own sandbox by pgid; no process from these runs remains.

## Screenshot tour (arc 3)

`specs/zz-arc3.spec.ts` run alone through `agent.sh` (first run exit 0, `1 passed (9.3m)`, its rail-count step skipped; the rail-count re-run exit 0, `1 passed (1.4m)`), then deleted; never committed. 30 captures: 00-landing (1440, 1100, 390; the disconnected bridge, whose captures were byte-identical to it, was dropped), 01-picker, 02-verify (Tab pressed once, focus on the × with `:focus-visible`), 02b-choose-account (paused before the answer), 03-connected, 03b-account-menu, 03f-rail-count, dark and light, 1440 and 390 unless named. The per-capture report: no horizontal scroll, the picker panel 480px at 1440 and 358px at 390 (verification and chooser alike), the picker row 432×66 at 1440 (the board's ~66px) and 310×88 at 390, where the chip wraps under the name.

## Board vs capture

Checked against DCQWalletModal (the picker; the only wallet-dialog board) and, for the chrome, DCQBridgeToken and DCQFoundations:
- Matches: scrim over static; panel 480, notch-6, padding 24, title 20/700 with the 36px × ; description line and its copy; rows as full-width buttons with the 40px tile, wallet glyph on a line-grey tile, 15px name, "Web app" chip on the panel fill, Mono id line, accent "Connect ›"; static 6px amber scanning square; right-aligned auto-width Cancel; the rail's magenta count chip beside Activity; Connect Aztec magenta with the 24px wallet icon and Connect Ethereum raised secondary; Ethereum chip with the grey caption and 12px ×.
- **Chooser tick (flag):** the choose-account dialog still marks its selected row with a small check beside the reverse video. G111 removed the tick from the account menu only; no board draws the chooser.
- **Rail count at 390 (flag):** the needs-you record auto-opens the dock over the phone layout, covering most of the tab bar, so the 22px tab chip shows only at the edge. The dock is unmounted at ≤760 in phase 11 (Q3 A); the 1440 capture shows the chip whole.
- **Collision strip:** not reachable through the harness (the test wallets announce distinct ids); signed off from the OQ20 mockup plus the unit test, as the plan says (I6). Its copy keeps today's caveat, not the board's "pick the one you installed" (OQ20 A).
- **Light theme:** no board draws a light wallet dialog; the capture uses the light roles (`--ul-well` tile, `--ul-line` fallback, panel chip on the raised row).
- Pre-existing harness artefacts: `fullPage` captures at 390 show the fixed scrim only over the first 844px, and the hidden test-wallet frame leaves a grey box over the rail's brand corner.
- Differences owned by later arcs: the open dock's anatomy (arc 4), the footer (arc 7), the phone header and chips (arc 9).

## Flags for owner sign-off

- **D25 (security deviation from OQ19 A):** a wallet claiming a type other than extension or web shows "Unknown type"; its claim appears only in the tooltip ("Self-reported: …").
- Picker rows ignore a click for 500 ms after the row set or the collision state changes; a user who clicks a row the instant it appears must click again.
- The wallet id line (`id head…tail`) is new visible text, sanitized and claimed by the wallet.
- The chooser's check (above) and the rail count at 390 (above).

## Codex post-implementation review, round 1 (PR layer 2)

Four Medium and eleven Low findings, no High. Every Medium and nine Lows were accepted and fixed; two Lows were left.

Medium, accepted:
- **Malformed announcements (known #10).** The SDK passes an announcement's id, name and icon through unchecked, so a numeric or null id threw while the picker rendered. `admitAnnouncement` now drops an announcement whose id or name is not a string, before it becomes a row or a provider entry, and treats a non-string icon as absent; nothing is coerced. Unit test: a numeric id and a null name are ignored, and the valid row beside them stays.
- **Hostile symbol overdraw (known #1).** `.symbol` is `flex: 0 1 auto; min-width: 0` with ellipsis; `.name` takes a zero basis, so it gives way first and the symbol shrinks only once the name is gone. The hostile list fixture gained a 32-character `W…` symbol, and the hostile cell measures it at 390px: the symbol box must end at or before the balance box. Before the CSS fix the cell failed (symbol right edge 500 against the balance's left edge 266); after it, it passes. The symbol span gained the `sendTokenSymbol` test id.
- **Picker accessible name dropped the id.** Each row's id line has a per-row id and the button's `aria-describedby` points at it; the `aria-label` is unchanged. Unit test: two rows with one name and type but different ids are described as `id 7c1e…a4f0` and `id 0bad…beef`.
- **Picker hover contrast.** On row hover the id line takes `--ul-ink-2` (5.41:1 dark, 5.62:1 light on `--ul-line`, up from 3.37 and 3.57) and "Connect" takes `--ul-ink` (9.61:1 and 10.79:1, up from 3.68 and 3.75). Both pairs were already pinned in `packages/design/src/theme-contrast.test.ts` (`--ul-ink` and `--ul-ink-2` on `--ul-line`), so nothing was added there.

Low, accepted:
- The search field's comment and the phase 4 owner flag no longer claim Escape clears the field.
- The plan's key interfaces give `markOf` its shipped `MarkSubject` signature.
- The grey monogram upper-cases before taking two code points (`ßß` → `SS`); unit case added.
- The wizard skips the heading focus while focus is inside the step rail (an arrow key keeps it on the tab) and still moves it to the heading when a panel control advances; both unit-tested through a focusable tab in the rail stub.
- The detached-opener dialog test spies on the opener's `focus` and asserts no call; removing the `isConnected` guard now fails it.
- The dialog scrim cancels only when the press and the release both land on it, so a selection dragged out of the panel (or into it) no longer dismisses the dialog. `clickScrim` in `@unleashed/design/testing` drives a real scrim gesture; the three backdrop tests (Dialog, picker, chooser) use it. A new test covers panel-to-scrim and scrim-to-panel drags; making any scrim-targeted click cancel fails it.
- `walletIdLine` sanitizes a 64-unit window at each end of the raw id, so an id longer than the sanitizer's bound shows its real last four; a 100-character id is unit-tested.
- The settle window uses `performance.now()`; the fake-timer tests still pass, since vitest fakes `performance` by default.
- Comments: the `.row-line.on`, step-strip text-column and rail-count comments are gone, TokenTile's address comment is one sentence, and the focus trap's comment states Tab containment and the one-active-trap rule.

Left:
- **#6:** closing traps in reverse watcher order restores focus to `<body>`; the awaited picker → verification handoff never takes that order.
- **#12:** the fallback wallet tile's `--ul-line` fill merges into the row's hover fill; its glyph stays legible. Owner sign-off below.

### Flags for owner sign-off

- Picker row hover: the id line brightens to ink-2 and "Connect" turns from the accent to ink.
- The fallback wallet tile disappears into the hover fill, leaving its glyph (#12, unchanged).
- A long token symbol ellipsises after the name is gone; before, it pushed past its column.
- Focus stays on the step rail's tab while arrowing through steps; a screen reader hears the tab, not the step heading.
- A press inside a dialog released over the scrim no longer closes it.

### Gate

Run (`impl/gate-r1.sh`, `impl/e2e-r1.sh`, concurrently):
- `bun run lint` exit 0 (complexity-baseline OK; the one warning and two infos are the pre-existing ones). `bun run typecheck:all` exit 0. `bun run test:all` exit 0 (design 232, bridge-core 447 + 1 skipped, tools 1496 in 105 files). `bun run --cwd apps/tools test:e2e` exit 0 (30 tests).
- `git diff --exit-code <rev> -- scripts/complexity-baseline/manifest.json` exit 0.
- `agent.sh specs/tokens-hostile.spec.ts specs/spike.spec.ts specs/tokens.spec.ts` exit 0: `11 passed (10.0m)`, no retries. Every connect opened the picker, with its rows now described by their id lines, and the verification dialog with the new scrim handlers (no cell clicks the scrim); the spike viewport cell advances through the wizard's steps from panel controls at 390 and 1024. The fail-first run of the hostile cell alone, before the CSS fix, exit 1 on the box assertion. Both sandboxes were stopped by pgid.

### Round 2 (fix diff)

Material findings 0. One low was accepted and fixed: touch and pen capture the pointer implicitly on `pointerdown`, so a press on the scrim released inside the panel would still report both the release and the click on the scrim. The scrim now releases that capture on a press it receives. A unit test covers the release; no browser test emulates touch capture. PG exit 0 (design 233, bridge-core 447 + 1 skipped, tools 1496, smoke 30).

## Re-tour after the review fixes (arcs 2 and 3)

Run with temporary `zz-retour*` specs through `agent.sh`; the specs were deleted and never committed. No capture scrolls horizontally.

**No existing capture was retaken.**
- Hover colours: no arc 3 capture hovers a picker row; every `01-picker` row is at rest.
- Token row CSS: an A/B check in one page injected the pre-fix `.symbol` and `.name` rules over ordinary rows at 1440, 1100 and 390 in both themes, then removed them. Measured on the USDC row, the only difference is a one-pixel anti-aliasing column at the right edge of the name: three pixels, with a maximum channel delta of 23/255. The old content-width name box clipped the last glyph's overhang. The name rule alone reproduces it and the symbol rules alone change nothing, so every row whose name fits shows the same column. Layout, truncation and position are identical, and the difference sits below JPEG q72 noise. So arc 2's 03-token, 03c-lookup, 03d-background-strip and 03e-token-exit stand, and so do the arc 3 captures that show the list. The id-tail and monogram changes only alter ids longer than 64 units and letters such as ß; no earlier capture has either.
- `aria-describedby`, the settle clock, the scrim gesture: no pixels.

**New captures:**
- arc 3 `01b-picker-hover` (dark and light, 1440 and 390): the plain row is hovered. Its id line measures `--ul-ink-2` (#b4b4af dark, #48464f light) and its "Connect" `--ul-ink` (#ededea, #18171c). The resting rows keep ink-3 and the accent.
- arc 3 `01c-picker-long-claim` (1440 and 390): a tour-only init script rewrites the selfpay frame's discovery answer to an 82-character name and a 100-unit id. The name stops at 48 graphemes plus "…" and wraps to 2 lines at 1440 and 3 at 390, with the chip below it. The id line reads `id clai…TAIL`, the id's real end. The row measures 432×106 at 1440 and 310×124 at 390.
- arc 2 `03g-token-long-symbol` (1440, 1100 and 390): the hostile fixture's 32-W row, plus a tour-only row with the same symbol and a 32-character name. The digest pin refuses any list file except the committed fixtures, so the extra row enters through the app's own catalog cache. At 1440 the symbol is whole (416px), "Wide Symbol" is whole and the long name is ellipsised in 144px. At 1100 both names are ellipsised to 28px. At 390 both names are 0px and both symbols are ellipsised at 162px, ending at x 246 against the balance's 266.
- arc 2 `04b-rail-arrow-focus` (1440 and 390): the user picks USDC, then presses ArrowUp on the Amount tab. Token becomes active and focus stays on its tab, with `:focus-visible` and the inset ring. Before the fix, focus moved to the hidden heading and no ring showed.

**Looks wrong, not fixed here:**
- The fallback wallet tile disappears into the hovered row's fill and leaves only its glyph (#12, flagged above). It shows in all four `01b` captures.
- No Latin symbol within the 32-code-point cap ellipsises at 1440 or 1100; only the name gives way there. The symbol's ellipsis appears only at phone width.
- At 1440 and 1100 the list is scrolled to its end, so the list's own clip cuts a partial row under the search field.
- Pre-existing, not from these fixes: at 390 the collapsed Activity dock overlaps the right edge (phase 11 unmounts it), and the fixed scrim covers only the first 844px of the `fullPage` picker captures. The balances (USDC 4,000.00 after repeated mints on one sandbox), the picker row order (discovery order) and the hostile rows behind the dialogs are harness data.
