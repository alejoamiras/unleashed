# Phase 4 — Token step bugs and row layout

## What was done

- **G03 + G152:** `SendWizard`'s background-strip classes are now `.bg-strip`, `.bg-strip-dot`, `.bg-strip-text` and `.bg-strip-link`. The wizard's scoped `.strip` rule no longer reaches `MintStrip`'s root, which is slot content and carries the wizard's scope id. `MintStrip`'s `.buttons { margin-left: auto }` is gone, so the mint buttons follow the lead, and its bottom margin is 16px (G114). `backgroundLine` returns `{ text, failed }`, and the dot carries `data-tone="running" | "failed"`: ink while running, `--ul-attention` when failed (carrier means done).
- **G79 + G35:** each mint button leads with a 12px `download` glyph, inline-flex with gap 8, Mono 700 14px. While a mint runs the button keeps "+100 USDC", sets `aria-busy="true"` and shows `BusyPixels` after the label (`aria-hidden`, since the button carries the state). All mint buttons stay `disabled` during a mint; the busy one keeps ink and `cursor: progress` so the pixels read as progress and not as a disabled control.
- **G81 + G08:** token rows rest transparent (`--ul-fill: transparent`), take `--ul-raised` on hover, and keep reverse video when selected. Symbol and name share one baseline with gap 8 (name 13px ink-2, ellipsised; `--ul-line` on the pick). The trimmed 8…6 address is on every row, manifest rows included, and the full checksum is in every row's `title`. Ident gap 3, `flex: 1`; rows 60px with 0 16 0 12 padding; the balance is the bare number. The hover colour override (ink-3 → ink-2) is deleted: its reason was the old `--ul-line` hover fill, and ink-3 on `--ul-raised` is already a pinned ≥ 4.5 pair.
- **G80, G118, G82 (minus the mark), G114:** the search field draws `<Icon name="search" :size="24" color="tertiary"/>` instead of the stroked lens; `::-webkit-search-cancel-button` has `appearance: none`. The lookup's Add leads with a 12px `plus` and has 0 14 padding (`.lookup .add`, so it wins over the Button module's `.small`); meta is ink-2; ident gap 3. Step gap 16, list gap 6, list max-height 356px.
- **Tests:** `SendWizard.test.ts` hoists the mocked journal runtime (`journalRuntime`, reset in `beforeEach`), and the "Run in background" case now asserts the dot's `data-tone` reads `running`, then `failed` with the "needs your attention" line once the record gets an `error` attention. `MintStrip.test.ts`: the busy button keeps "+100 USDC", only it has `aria-busy="true"`, and `aria-busy` clears after the mint. `TokenTile.test.ts`: "shows no address for a manifest token" became "every row shows its trimmed address, manifest included, with the full checksum on hover"; the balance case asserts the bare "1,234.50".

## Attempts and notes

1. The first `TokenTile` balance assertion read the `.balance` class. It moved to a test id (below) once the browser spec needed one too.
2. `specs/tokens.spec.ts` (the mint case) waited with `expect(tile).toContainText(/\d/)` and compared the tile's whole `textContent` before and after the mint. With the address on every row, the row has digits before its balance loads, so the wait could pass early and `before` could be captured without a balance; the poll would then pass on the balance arriving rather than on the mint. The spec now reads the balance through a new `sendTokenBalance` test id (registered in `lib/testids.ts`), which keeps the assertion as strong as before.
3. No other spec reads a token row's text: `tokens-hostile.spec.ts` and the exit/send page objects select rows by `data-key`, and `send-smoke.test.ts` checks "WBTC" and "added by you", both still present.

## Deviations from the plan

- **New test id `sendTokenBalance`.** Not in the phase's list; needed so the mint spec keeps waiting for the balance (attempt 2). It is display-only and not interactive, so `testid-coverage.test.ts` needs no entry.
- **Mint-button busy colour and cursor.** The plan says only "adds BusyPixels and aria-busy". The busy button is `disabled` like its siblings, and `.mint:disabled` greys the text, which would grey the pixels too; the busy one keeps ink and takes `cursor: progress` (the Components board's busy cursor). This is a native `<button>`, not `Button`, so the D13 `cursor: progress` deviation for `Button` does not apply here.
- **Lookup mark font stays 12px.** G82's board value is Next 800 11, but the mark is replaced by `TokenMark` in phase 5, so this phase leaves it ("G82 minus the mark").

## Validation gate

Run (`impl/pg4.sh` and `impl/e2e4.sh`, concurrently; each command's exit code logged):
- PG: `bun run lint` exit 0 (complexity-baseline OK; the two infos are the pre-existing notes). `bun run typecheck:all` exit 0. `bun run test:all` exit 0 (design 217, bridge-core 447 + 1 skipped, tools 1480). `bun run --cwd apps/tools test:e2e` exit 0 (30 tests).
- Baseline: `git diff --exit-code <rev> -- scripts/complexity-baseline/manifest.json` exit 0; the same diff from the plan base exit 0.
- `bash apps/tools/scripts/e2e/agent.sh specs/tokens.spec.ts specs/tokens-hostile.spec.ts specs/activity.spec.ts` exit 0: `8 passed (7.8m)`, no retries. `activity.spec.ts:87` (the backgrounded send's strip, reached by `sendBackgroundStrip`) passed unchanged, so the test id survived the class rename; `tokens.spec.ts:51` (the mint) passed with the balance-scoped wait.

## Board vs capture

No tour in this phase's gate (arc 2's tour runs in phase 6). Values were checked against the BridgeToken board source: strip padding 6 6 6 8 and gap 12, mint button inline-flex gap 8 / 36px / 0 12 / Mono 14 700 with a leading 12px download; search 48px, 24px glyph, gap 10; rows 60px, 0 16 0 12, gap 12, ident gap 3, name line baseline gap 8, name #B4B4AF (ink-2) and #3A3A42 (line) on the pick, address Mono 12 ink-3, balance Mono 15 (600 on the pick); list gap 6; lookup Add 0 14 padding, gap 6, leading 12px plus, meta 13px ink-2.

## Flags for owner sign-off

- The busy mint button (ink label, pixels, progress cursor) has no board; it follows the Components busy pattern on a secondary-looking control.
- The browser's clear × is gone from the search field; clearing is by selecting the text and deleting it. No board draws a clear control, and the optional 32px close-12 clear button from recon is not built.
