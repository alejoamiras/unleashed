# Phase 1: workspace and build pipeline

Gate: `bun install --frozen-lockfile`, `bun run lint`, `bun run typecheck:all`, `bun run --cwd apps/landing test`
(13 tests), `bun run build:landing` (the guard runs inside `build`) and `bun run test:ci-gating` (31 tests): all exit 0.

- **Inference 3 holds.** `vite.config.ts` imports `src/markup.ts`, which imports `@unleashed/design/core/icons.ts`
  and `core/mark.ts` through the workspace link; Vite's default config bundler resolves them under plain Node. No
  `--configLoader runner` needed.
- **Inference 7 holds.** In a `git archive HEAD` export (no clone), `bun install --frozen-lockfile --filter
  @unleashed/landing` installs 201 packages, none of them `@aztec-*`, and the build passes its guard.
- **The build reproduces across install shapes.** The export (filtered install) and the worktree (full install),
  both built with `WORKERS_CI_COMMIT_SHA=c435e058…`, print the same `DIST_SHA256=3abf318c…`. This is the local half
  of Inference 11; the Workers Builds half waits for phase 6.
- **The lockfile moves only for the workspace.** `bun.lock` gains `apps/landing` and re-hoists
  `@jridgewell/trace-mapping` (0.3.31 and 0.3.9 swap places, both already locked). No new package version.
- **Biome lints CSS for specificity order.** `noDescendingSpecificity` warns when a lower-specificity selector
  follows a higher one that could match the same element, even when they never do. Ordering the sections from
  general to specific (page, nav, buttons, hero, caveat and footer, experiments) cleared all five warnings with
  no change in effect.
- **Deviation from the plan's file list.** `testids.ts` is not created: the smoke selects by role, by `data-engine`
  and by `data-motion`, which the markup needs anyway. The build guard is split into `scripts/dist-checks.ts`
  (pure rules, unit-tested) and `scripts/verify-build.ts` (the CLI); both import only `node:` built-ins and
  `src/content.ts`.
- **Build id.** `<version>+<first 8 hex of the commit>`, the tools app's format, so the live check compares
  the same shape on both Workers.

LESSONS_FILE=implementations-plan/landing/lessons/phase-1.md
