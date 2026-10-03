# Phase 2 — Glyph set, icon sizes, wordmark

## What was done

- **Step 1 (G01):** the twelve names (`search plus minus wallet eye eye-off zap key save reload repeat tv`) joined `NAMES` in sorted order; `bun packages/design/scripts/vendor-icons.ts` printed "wrote 31 icons" and, after `biome check --write`, the `icons.ts` diff is add-only (71 insertions, no deletions). Every path of the twelve was found byte for byte in the board sources (a scratch check).
- **Step 2 (G26, G145):** `Icon.size` is `IconSize = 12 | 24 | "12" | "24"`, default 12. The 38 sites at 16 moved exactly as the gap table lists (26 to 12, 12 to 24). The account-menu copy button is a centred 32×32 target with a 24px glyph; `margin-right: 8px` keeps the glyph's right edge 12px from the menu edge, where the old padding put it. vue-tsc proof: a scratch edit putting `size="16"` and `:size="16"` back at two sites failed `typecheck` with `TS2322: Type '"16"' is not assignable to type 'IconSize | undefined'` (and the same for `16`); the edit was reverted before the commit.
- **Step 3 (G05 font):** the upstream TTF at the pinned google/fonts commit matched blob `1617be9f…` and sha256 `aa8c653e…`. fonttools 4.66.0 and brotli 1.1.0 went into a scratch venv with `pip install --require-hashes -r` a scratch requirements file pinning the two cp312 manylinux x86_64 wheels by the sha256 PyPI lists for them. The same tools first re-cut the old 39-code-point subset byte for byte (`e080370f…64dd`), then the new cut with U+0055: `2e89cec4…ab76`, 4076 bytes, 91 glyphs, 40 code points; COLR v1, CPAL and the four `fvar` axes (SCAN, BLED, XELA, YELA) survive; GSUB `aalt ss02 ss03 ss04` unchanged. `SOURCES.md` records the command, hash, bytes, glyph and code-point counts, and the wheel names and hashes; the `base.css:26` comment names U.
- **Step 4:** the rail wordmark reads `Unleashed`, the document title `Unleashed · Aztec tools`. `APP_ID`, the capability name and `TOOLS_APP_ID` stay `unleashed`.
- **Tests:** `Icon.test.ts` mounts size "24" and gains "renders at 12 when no size is given"; `mount-all.test.ts` mounts `size: "24"`. `fonts.test.ts` re-hashed against the new `SOURCES.md` row with no edit. Design suite 213 tests.

## Attempts and notes

1. To learn which wheel files pip resolves on this host, they were first fetched with `pip download --no-deps` (not hash-checked), and each file's sha256 was compared with the digest PyPI's JSON API lists for that filename: both matched. Only then was the requirements file written and the install run with `--require-hashes`.
2. The new subset is 4076 bytes, still under Vite's 4096-byte `assetsInlineLimit`. The build's never-inline rule for `.woff2` holds it out (BG: no `data:font`, the file ships as `assets/SixtyfourConvergence-subset-*.woff2`, 4076 bytes, in both targets).

## Deviations from the plan

- **Toast dismiss padding 4px → 6px** (`D:ui/Toast.vue`), not in the step list: the × shrinks from 16 to 12, and without it the target would shrink from 24px to 20px. The target stays what it was; phase 12 moves it to 28px.
- **The captures of the amount step keep the phase 1 names** (`04-amount-private-*`, private is on in this tour too) and replace them; every other phase 1 capture of the same surface is replaced by this tour's. The phase 1 Tab-focus captures (`02b-focus-*`, `03-focus-*`, `04-focus-*`) are left as they are.

## Validation gate

Run as one scratch script (each command's exit code logged):

- PG: `bun run lint` exit 0 (complexity-baseline OK); `bun run typecheck:all` exit 0 (design, bridge-core, tools); `bun run test:all` exit 0 (design 213, bridge-core 447 + 1 skipped, tools 1480); `bun run --cwd apps/tools test:e2e` exit 0 (30 tests). Baseline: `git diff --exit-code <rev> -- scripts/complexity-baseline/manifest.json` exit 0.
- BG: `build:testnet`, `verify:build-target testnet`, `build:mainnet`, `verify:build-target mainnet` each exit 0; no `data:font` in either `dist`; `ls apps/tools/dist/assets/*.woff2` lists `SixtyfourConvergence-subset-4giBQd2s.woff2` (4076 bytes) beside the two Atkinson files in both; `diff "$SCRATCH/headers-<t>" apps/tools/dist/_headers` exit 0 for both; `verify:deployments` exit 0.
- T: `agent.sh specs/zz-arc1.spec.ts` exit 0, `1 passed (2.6m)`; the spec was deleted afterwards and never committed. 60 JPEGs: 00 landing (1440, 1100, 390), 00b disconnected, 01 picker, 02 verify, 03 token, 03b account menu, 03c lookup, 04 amount (private), 05 review (Details open), 06 in-flight, 07 receipt, 08 activity, 09 faucet, 10 faucet after a drip (toast up), dark and light, 1440 and 390; 06b in-flight with the dock open at 1440. Every capture reviewed, none shows a board.
- In-page audit at every surface and width (dark): every visible 24-unit icon has `width` 12 or 24, none off the grid; the wordmark text is `Unleashed`, and a 40px "U" set in `"Sixtyfour Convergence", serif` and in `"Sixtyfour Convergence", monospace` measures the same 40px, so the U comes from the pixel face, not a fallback (a zoomed capture of the brand shows the red COLR "Unleashed"). Icon-only buttons measure 32–48px (L1 disconnect 32, account-menu copy 32×32, card corners 36, caret 44+) except two unchanged ones: the dock strip toggle (44×72, the rail's full-height strip) and the toast dismiss (24×24, as before this phase).

## Board vs capture

The boards set 24-unit icons only at 12 and 24 (every board source); the captures now do too. The wordmark matches BridgeToken's capital "Unleashed". With the Aztec chip's chevron and the Ethereum chip's × at 12, both chips sit within 4px of BridgeToken's positions (they were 8px off).

Differences that are not decisions of this phase, each owned by a later phase:
- Stroked 16px search lens (G80), raised token rows, striped marks and missing addresses, the done-looking step rail (arc 2); the lilac "Testnet" chip and neutral busy ring (phase 3); header chips, the rail count chip and the icon-less Connect buttons (arc 3); card status chips, the dock at 390 and toast anatomy (arc 4); receipt and faucet anatomy (arcs 5–6); amount, gas and review anatomy (arc 7); in-flight phase list (arc 8).
- The crossing phase's loader reads fainter at 12 than it did at 16; the InFlight board draws its phase glyphs at 12, and the phase list is rebuilt in phase 22.
- The theme control keeps the single cycling button (Q1 A); only its icon shrank to 12.
- Harness artefacts, also in the base captures: the grey box over the rail's top-left corner and, at 390, over the top bar's wordmark (the hidden test-wallet frame's container); the full-page phone captures show the fixed scrim over the first viewport only.

## Flags for owner sign-off

- The toast dismiss keeps a 24px target until phase 12 (below the 32px floor the gate names for hit areas; unchanged by this phase).
- Every surface's 16px icons are now 12 or 24 per the gap table; the smaller 12px glyphs on the step rail, chips, checks and inline notes are the most visible change in the dark captures.
