# Phase 1 — Static, recess roles, focus ring, tracking

## What was done

- **Before any change:** both targets were built from the untouched tree (docs-only commits on top of the plan base) and their `dist/_headers` kept as the BG baseline (`headers-testnet`, `headers-mainnet`).
- **Step 1 (`base.css`):** G02 static filter gains `color-interpolation-filters='sRGB'` and the boards' blue table `0.05 0.22 0.56 0.92` (R/G stay `0.04 0.2 0.55 0.93`); the URI stays percent-encoded with no `;`. New tokens: `--ul-field` and `--ul-track` (#08080a dark; #f4f1e8 / #e9e4d6 light), light `--ul-well` → #fbf9f3, `--ul-ring: var(--ul-ink)`, `--ul-perforation` (transparent dark, `--ul-line` light), `--ul-tracking-heading: -0.015em`. The global `a/button:focus-visible` ring is `2px solid var(--ul-ring)` at offset 3px. The false depth comment is corrected; the design README names the ring and the three recess roles.
- **Step 2:** the ten G72 field consumers read `--ul-field`, `WizardShell`'s segment reads `--ul-track`; the five page-level consumers (`AppShell` rail, `DockStrip`, `SendView`, `ActivityView`, `BridgeJournal` placeholders) keep `--ul-well`. G98: `.seg.sel:disabled` keeps the ink fill with `--ul-bg` text and `cursor: not-allowed`.
- **Step 3:** `SectionHeader` draws the perforation (G73); the three hard-coded outlines (`BridgeJournalCard .corner`, `ChooseAccountModal .row`, `ActivityView .tile`) read `--ul-ring`; the six heading sites read `--ul-tracking-heading` (three dialog titles, the dock h2, the first-visit h2, `SectionHeader` h1).
- **Tests:** `base-css.test.ts` pins the sRGB attribute and the R/G/B tables; `theme-contrast.test.ts` adds `--ul-field`/`--ul-track` to FILLS (ink, ink-2, ink-3 ≥ 4.5 in both themes) and `--ul-ring` on bg/panel/raised ≥ 3. Design suite 212 tests (18 new).

## Attempts and fixes

1. The first perforation was the plan's `border-bottom: 2px dotted var(--ul-perforation)` on `.header`. The first tour showed it lifts the header's content by 1px in both themes (the border eats 2px of the 72px min-height), so the dark captures differed from the base captures by more than static, focus and tracking. Both boards (BridgeAmount, AmountLight) keep the title at y=24 and the card at y=100 in either theme. Fix: the header is `position: relative` and the perforation is an `::after` overlay on its last 2px. The account menu (`z-index: 50`, anchored to its own `.switcher`) still paints above it. Re-toured: title back at y=24, dotted rule at y≈71 as on AmountLight.
2. No image library on this host (no PIL, numpy, ImageMagick; `Bun.Image` exposes no pixel access). Region stats were measured by drawing the captures onto a canvas in Playwright's Chromium from a scratch script.

## Deviations from the plan

- **G73 is an overlay, not a border** (attempt 1): same look, no layout shift between themes.
- **The three hard-coded outlines also move to offset 3px**, not only to `--ul-ring`, so every button's ring is the same "2px ink ring 3px off" the global rule draws. The step named only the colour.
- **`ActivityRow .amt:focus-visible { outline-offset: 2px }` is left as is.** It restated the old global offset; it now makes that one button's ring 2px off. Not in the phase's file list; flagged below rather than changed.

## Validation gate

- PG (`pg.sh`, final run): `bun run lint` exit 0 (complexity-baseline OK; the one Biome warning is the pre-existing unused import in bridge-core); `bun run typecheck:all` exit 0 (design, bridge-core, tools); `bun run test:all` exit 0 (design 212, bridge-core 447 + 1 skipped, tools 1480); `bun run --cwd apps/tools test:e2e` exit 0 (30 tests). Baseline: `git diff --exit-code <rev> -- scripts/complexity-baseline/manifest.json` exit 0.
- T: `agent.sh specs/zz-arc1.spec.ts` exit 0, `1 passed (1.9m)`; 26 JPEGs (01 picker, 02 verify, 03 token, 04 amount with private on, 04 Tab-focused Continue, 05 review, 09 faucet; dark and light; 1440 and 390, focus at 1440). Every capture reviewed, none shows a board. The spec was deleted and never committed.

## Board vs capture

Measured (1440, JPEG q72):

| Surface | Before | After | Board |
|---|---|---|---|
| Picker scrim, dark, luma mean | 55.5 | 36.0 | 35.6 (WalletModal) |
| Private veil, dark, luma mean | 153.1 | 91.9 | 91.5 (BridgeAmount) |
| Light amount field | #f9f7f0 (invisible on sheet) | ≈ #f5f1e8 | #f4f1e8 |
| Light direction track | #f9f7f0 (invisible) | ≈ #eae4d6 | #e9e4d6 |
| Light rail | #f9f7f0 | ≈ #fbfaf6 | #fbf9f3 |

The scrim now reads as dark static (light scrim mean 80.5 → 61.0), the light field, direction track, review Send band, faucet balance wells and emoji grid stand off the sheet, the perforation runs under every light header, and the ink ring shows on the magenta Continue in both themes. Dark captures differ from the base captures in static, the ring and heading tracking (plus per-run account addresses).

Differences that are not recorded decisions of this phase, each owned by a later phase:
- 03 light: the mint strip reads raised, not field: `SendWizard`'s scoped `.strip` still styles `MintStrip`'s root (G03, phase 4).
- Lower-case wordmark, 16px icons (phase 2); the done-looking step rail and raised token rows (arc 2); amount, gas and review anatomy (arc 7). All unchanged by this phase.
- 390: the dock's "Activity" aside still renders on phones (Q3 A, phase 11).
- 09 dark: the Activity dock is collapsed where the base capture had it open on a Done record. The dock's open or collapsed state follows the records the run holds, not this phase; the account chip moves right with it.
- Harness artefacts, also in the base captures: a grey box over the rail's top-left corner (the hidden test-wallet frame's container), and in full-page phone captures the fixed scrim covers only the first viewport.

## Flags for owner sign-off

- The G73 overlay and the 3px offset on the three restated outlines (Deviations).
- `ActivityRow`'s open-amount button keeps a 2px ring offset.
- The locked direction pick (G98) is not in this tour: the segment locks only while the wizard is busy, which this tour never holds. It is a CSS-only change with no unit test; a later tour that holds a busy state should capture it.
- The direction segment's ring sits 1px off, not 3px (Verifier round 1).

## Verifier round 1

Accepted:
1. **Chooser ring clipped (medium).** Confirmed: `.rows` scrolls (`overflow-y: auto` also clips x) with a 4px inset, and the ring at 3px off plus 2px wide reaches 5px, so its outer pixel was cut on both sides of every row and past the first and last. Fix: the inset is `margin: -5px; padding: 5px`, which keeps the board's "3px off" and moves nothing (the negative margin cancels the padding); the comment now states the 5px budget. Keeping offset 2px was the other option; rejected so every button's ring stays 3px off. Note for phase 9: `WalletPickerModal .rows` has the same 4px inset and needs 5px once its rows are full-width buttons under the global ring.
2. **Direction segment ring overruns the track (low).** Confirmed: 5px of ring against a 4px pad and a 4px gap crossed the track edge and touched the neighbour by 1px. Fix: `.seg:focus-visible { outline-offset: 1px }`, so the ring reaches 3px, inside the pad, with 1px of track before the edge and the neighbour. A 5px pad and gap would grow the head by 2px on every Send capture; an inset ring (TokenTile's pattern) would sit inside the ink pick, which is always the focused segment under the roving tabindex, and read only as a shrunk fill.
3. **09 dark dock state not listed (low).** Confirmed against the base capture: that run had the dock open on a Done record; this one had it collapsed. Recorded under Board vs capture as harness state.

Rejected: none.

Re-tour (`zz-arc1.spec.ts`, run alone, exit 0, `1 passed (1.2m)`, deleted afterwards): Tab-focus captures at 1440 in both themes, `02b-focus-choose-account-*` (first row reached by ArrowDown/ArrowUp, `:focus-visible` asserted; ring whole on all four sides) and `03-focus-direction-*` (deposit segment reached by ArrowRight/ArrowLeft, `:focus-visible` asserted; ring inside the track, clear of the Exit segment). None shows a board.

PG: `bun run lint` exit 0 (complexity-baseline OK), `bun run typecheck:all` exit 0, `bun run test:all` exit 0 (tools 1480), `bun run --cwd apps/tools test:e2e` exit 0 (30 tests); baseline unchanged.
