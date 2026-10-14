# Phase 3: motion

Gate: the fast gate (39 unit tests), the build with its guard, and `test:browser`: 21 passed, 1 skipped (live only).

- **The board's field cost 6 ms a step; the port costs 1.2 to 1.6.** Measured in Chromium (headless, this host):
  100 steps at 1440×1500 CSS px with the pointer trace active, paint plus `putImageData`. Before: median 6.0 ms,
  p95 11.9 ms. Three causes, all in the per-cell loop: array destructuring of the colour (`const [r, g, b] = …`
  runs the iterator protocol), one `Math.sin` per cell for the diagonal wave, and `Math.hypot` for the trace. After
  reading colours by index, splitting the diagonal sine by angle addition into column and row terms, and boxing
  the trace before a plain `Math.sqrt`: median 1.2–1.6 ms, p95 1.9–2.6 ms over three runs. `fieldValue` computes
  the same expression term for term, and a unit test checks every cell of a 40×20 grid against it.
- **Exact cells are provable in a screenshot.** At 390 px and a 1.5× scale, a 12×600 CSS px clip of the right gutter
  decodes to 18×900 device px, and every vertical run of one colour is a multiple of 6. With the board's
  `width: 100%` sizing the test fails, so it is not vacuous.
- **0 is not a safe "no previous frame".** The loop first used `last = 0` as the sentinel, so a frame at time 0
  (the unit test's clock) lost its elapsed time. `null` it is.
- **Biome reads `.fit()` as a focused Jasmine test** (`noFocusedTests`). The engine method is `resize()`.
- **A thrown engine is isolated twice.** At start, `main.ts` catches and leaves the page as it was; while running,
  the loop drops the engine and reports it. The smoke's null-context case proves the first: the field is absent,
  Pause still toggles, and the page logs nothing.
- **The paused page requests no frames.** An init script counts `requestAnimationFrame` calls; after Pause, at
  most one more frame runs in the next second.

LESSONS_FILE=implementations-plan/landing/lessons/phase-3.md
