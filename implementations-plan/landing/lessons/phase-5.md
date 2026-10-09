# Phase 5: CI

`pr-quick.yml` gains a `landing` filter, a `needs-landing-build` output, a `build-landing` job that calls
`_build-landing.yml` (build with its guard, then the Chromium smoke), and one exact-state case in `quality-status`.
The check name stays `quality-status`, so branch protection needs no change.

Gate: `lint:actions`, `test:ci-gating` (32 pass), `lint`, `typecheck:all`, `test:all` with no `dist/` present, the
landing build and `test:browser` (26 passed, 1 skipped).

- **The landing filter leaves out `.github/actions/**`.** The `workflows` filter already covers it and feeds
  `needs-landing-build`, so naming it twice would add nothing.
- **`setup-playwright` installs Chromium with the tools app's Playwright binary**, keyed on the tools manifest. The
  landing reuses it, so the two `@playwright/test` pins must match; `behavior-gating.test.ts` now pins that, because
  a drift would install a browser revision the landing's Playwright cannot launch.
- **The landing's unit tests never read `dist/`.** `test:all` passes with the build removed, so the unit-test job
  needs no landing build before it.

LESSONS_FILE=implementations-plan/landing/lessons/phase-5.md
