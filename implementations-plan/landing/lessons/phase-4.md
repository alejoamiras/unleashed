# Phase 4: the card engines the owner picked

The owner's pick, quoted in plan.md (Owner verdict): B2 Both ways, F1 Drip, N1 Tuner. Placement: Strip, built as
provisional; `SCREEN_PLACEMENT` in `src/content.ts` switches to Tile, whose rules already ship in landing.css.

Gate: the fast gate (45 unit tests), the build with its guard, and `test:browser`: 26 passed, 1 skipped; 78 of 78
with `--repeat-each=3`. WebKit stays blocked on this host (phase 2).

- **Each engine is a model plus a host.** `CardModel` (`layout`, `step`, `draw` onto a cleared, scaled context) holds
  the board's logic; `CardScreen` owns the canvas, the device-pixel sizing and the panel fill. Models take a
  `Measure` and a random source, so the unit tests run them headless with a fixed-pitch font and a seeded generator.
- **The Tuner holds still at random.** A 4% chance per step of a 6–13 step hold (up to 1.6 s) made a two-sample
  "it moves" check flaky. The smoke polls for a changed frame for up to 4 s instead.
- **Static stays out of the palette.** The Bridge screen's veil uses the four fixed grey levels of `--ul-static`
  in both themes; they are the only colour literals in engine code.
- **Canvas text waits for its faces.** Cards start after `fontsLoaded([mono, body])`, bounded at 1.5 s, so the
  pills are measured in Atkinson Mono rather than in the fallback, which would leave them the wrong width.
- **Off screen means stopped.** At a 600 px tall window the Next screen starts `paused`, runs once scrolled into
  view, and pauses again when scrolled away (IntersectionObserver per canvas).
- **Biome's `useIterableCallbackReturn`** flags a `forEach` whose arrow returns a value (the board's
  `notchPath`); a `for…of` over the points is the fix.

LESSONS_FILE=implementations-plan/landing/lessons/phase-4.md
