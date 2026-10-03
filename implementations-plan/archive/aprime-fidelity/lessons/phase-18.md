# Phase 18 — Honest proving panel and the shared progress bar

## What was done

- **Lock start time.** `useDrip.ts`'s global `inflight` lock carries `startedAt: Date.now()`, set when the lock is taken. It lives on the lock, not the card, so the elapsed time survives the card's account-keyed remount.
- **`formatClock(ms)`** in `lib/phase-clock.ts`: whole seconds floored, "m:ss" under an hour and "h:mm:ss" from there; negative or non-finite input reads "0:00", so a heartbeat that lags the start never shows a negative time. Arc 8 reuses it.
- **`D:ui/ProgressBar.vue`**, exported from `@unleashed/design`, listed in the README's Progress bullet and in `mount-all.test.ts`. Props: `label` (the accessible name), optional `value` 0–1, `height` = 14, `tone` signal | lost | carrier. The root is `role="progressbar"` with `aria-label`; `aria-valuemin/max/now` are set only when `value` is given. The host is a notch-2 `.ul-notch` that declares both `--ul-fill` (`--ul-line`, the track) and `--ul-notch`, and clips with `overflow: hidden`. The fill has a 3px `--ul-ink` leading edge. Indeterminate: a 25% block that travels the track at `1.6s steps(8) infinite` (from −50% to 350% of its own width, so all eight frames show it, the first half in and the last flush with the far end), animated only inside `@media (prefers-reduced-motion: no-preference)`; under reduced motion it rests mid-track, so it never reads as a fill level. Determinate: the fill's width is the percentage.
- **Proving panel.** TokenCard's dripping status row turns into a column panel on the field fill:
  - a head row with the label ("Proving private…" / "Submitting…") and an m:ss clock, `aria-hidden` so the `role="status"` region is not re-announced every second;
  - the clock is computed from `useNow()` (the shared 1s heartbeat) minus `inflight.startedAt`;
  - an indeterminate `ProgressBar` named "{SYMBOL} drip progress";
  - the Mono line "waiting for your wallet to prove and send" with a static accent `_` cursor (`aria-hidden`).

  The panel never says where the proof runs and claims no percentage (OQ25 A).

## Tests

- `useDrip.test.ts`: new case. `inflight.startedAt` is a number while `sendTx` is pending. The pending-`sendTx` case at `:258-276` is unchanged.
- `phase-clock.test.ts`: `formatClock` maps 0 → "0:00", 14 000 → "0:14", 160 000 → "2:40", 3 725 000 → "1:02:05" and −800 → "0:00".
- `ProgressBar.test.ts`:
  - Indeterminate: no `aria-valuenow`, named by `label`, 14px high.
  - `value` 0.45: `aria-valuenow` "45" and a 45% fill.
- `mount-all.test.ts`: a ProgressBar entry.
- `TokenCard.test.ts`, in-flight case: the fake lock now has `startedAt` 14 s ago. The panel is checked for:
  - a `[role=progressbar]` with no `aria-valuenow`;
  - the line "waiting for your wallet to prove and send";
  - no "on this device" and no "%";
  - a `.clock` that is `aria-hidden` and matches `m:ss`.

## Attempts and notes

1. The global reduced-motion rule has zero specificity, so it cannot beat the module's keyframes. ProgressBar therefore gates the animation behind `prefers-reduced-motion: no-preference`, the same way `BusyPixels` does, rather than relying on the global rule.
2. A `.ul-notch` host must declare both `--ul-fill` and `--ul-notch` and cannot scroll. The bar never scrolls. `clip-path` clips only paint, so `overflow: hidden` is what keeps the off-track frames out of the page's scroll width: at 390 an unclipped frame would stick out about 29px past the card.
3. `steps(n)` is `jump-end`: it never draws the `to` keyframe. The first range, −100% → 400%, therefore drew an empty track for one frame in eight and clipped the last frame's ink edge.

## Deviations from the plan

None in behaviour. The `tone` prop and the determinate path have no caller yet: arc 8's stepper bar is their first user.

## Validation gate

Run, and again after the verifier's low fixes (same counts, drip spec 4 passed in 3.2m):
- `bun run lint` exit 0 (Checked 502 files; the pre-existing 1 warning and 2 infos; complexity-baseline check OK).
- `bun run typecheck:all` exit 0.
- `bun run test:all` exit 0 (design 240 in 22 files; bridge-core 451 + 1 skipped; tools 1566 in 106 files).
- `bun run --cwd apps/tools test:e2e` exit 0 (30 tests).
- Baselines: `git diff --exit-code <rev> -- scripts/complexity-baseline/manifest.json` exit 0.
- `agent.sh specs/drip.spec.ts` exit 0: 4 passed (2.7m). The run stopped its own sandbox by pgid.

The arc's LG runs at phase 21 with arc 7.

## Screenshot tour (arc 6)

A temporary `zz` spec ran once with `agent.sh` and exited 0 (1 passed, 1.7m); it was deleted uncommitted. Captures are JPEG quality 72 with the wallet iframe hidden. In every capture there was no horizontal scroll, and the dripping bar measured 14px with no `aria-valuenow`. The states captured:

| State | Widths | How it was reached |
|---|---|---|
| `09-faucet-disconnected` | 1440/1100/390 | before connecting |
| `09-faucet-idle` | 1440/1100/390 | connected, balances read |
| `09b-faucet-dripping` | 1440/390 | test wallet `holdNext("sendTx")`, then SIGNAL private |
| `10-faucet-dripped` | 1440/390 | released, `data-drip-status="ok"` |
| `10b-faucet-error` | 1440/390 | `failNext("sendTx")` on NOISE public |
| `11-faucet-adding` | 1440 | `holdNext("registerToken")`, Add SIGNAL clicked |
| `11b-faucet-added` | 1440 | released; the row unmounts and the toast says "SIGNAL added to your wallet." |

Every state was captured in dark and light.

Compared with the faucet board, the only differences are decided or pre-existing:
- **Decided (OQ25 A, G84, G76):**
  - The bar travels and claims no percentage; the board draws 45%.
  - The log line reads "waiting for your wallet to prove and send", not "proof building on this device".
  - While a drip runs, the other card is disabled and shows the lock reason. The board draws the other card enabled.
  - The footer credits stay links, with a dotted underline.
- **Carried from phase 17 (flagged there):**
  - The dripping card's disabled public button keeps its `eye` glyph.
  - At 390 the ok strip wraps "Sent 1,000 SIGNAL to private" onto two lines beside "View tx".
  - "Added" never shows; the add row unmounts on success. `11b` shows the empty space it leaves above the strip, because the strip keeps `margin-top: auto`.
- **Pre-existing, outside arc 6:**
  - Balances read "0.00" where the board draws integers ("2,000", "0"). This is the existing two-decimal formatting.
  - In `10-faucet-dripped` at 1440, the private balance still reads "0.00" 1 s after `ok`; the 390 capture taken moments later reads "1,000.00". This is refresh timing, not a render fault.
  - Shared chrome is not arc 6's work (arcs 1–5 and 10): the sidebar's theme control and the Activity badge, the ellipsized page subline at 390, and the toast overlapping the SIGNAL card at 390.
  - The grey box at the top left of every capture is the harness's wallet frame handle.
- **New in this phase, flagged:** at 390 the log line wraps to two lines inside the panel. It stays legible and nothing overflows.

## Verifier

A fresh general-purpose reviewer read the plan, the board and the diff, and ran the touched unit tests. It found no high or medium defects.

It probed the following and found them correct:
- **Reduced motion:** the animation exists only under `no-preference`, so the zero-specificity global rule has nothing to override. Declared unconditionally, that rule would have parked the block off-track at the `to` frame.
- **The `.ul-notch` host variables.**
- **`useNow()`:** one app-wide interval. Idle cards never read `elapsed`, so they do not re-render each second.
- **`formatClock` edges.**
- **The clock across a disconnect → reconnect remount.**
- **No per-second re-announcement:** the only text that changes each tick is `aria-hidden`, so it stays out of the accessibility tree.

Its findings:
- **Low, accepted:** the travel range left one empty frame per cycle and clipped the last frame's leading edge. The range is now −50% → 350%, which differs from its suggested −75% → 325% so that the last frame reaches the far end.
- **Low, accepted:** the host's comment credited only `clip-path`. It now also names `overflow: hidden`.
- **Low, done in the docs commit:** the lessons file and the ✓ were not yet committed.
- **Notes for arc 8, recorded, no change:**
  - `value: 0` draws a 3px ink sliver at 0%.
  - `aria-valuetext` falls through to the progressbar root, since it is a single-root SFC.
  - A determinate width transition (G09's `360ms steps(6)`) belongs inside ProgressBar's determinate branch.
  - The track colour is fixed to `--ul-line`.
- **Pre-existing, recorded, no change:** after a disconnect → reconnect mid-drip, the detached old card instance resolves `lastDrip`, so the new card never shows "Sent…".

## Flags for owner sign-off

- New copy and look: the proving panel ("Proving private…" + m:ss clock, an indeterminate travelling bar, "waiting for your wallet to prove and send_"). The board's 45% bar and "proof building on this device" were dropped for honesty (OQ25 A).
- Under reduced motion the bar's block rests mid-track, static.
- At 390 the log line wraps to two lines.
