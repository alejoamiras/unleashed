# Phase 2 — primitives: notch, static, icon, motion

## Result
Gate passed.
- **PG:** lint, typecheck:all, test:all and the jsdom smoke all pass.
- **Named checks:** `boundary.test.ts` passes (no raw HTML; icons render as `<path v-for :d>`). The `AccountSwitcher` and `AztecWalletPanel` suites pass unchanged (21 tests).
- **New tests:**
  - `Icon.test.ts`: multi-path order, the `chevron` alias, `label` toggling `role="img"`/`aria-label` against `aria-hidden`, the colour map, string `rotate`.
  - `mount-all.test.ts`: sizes 12, `"16"` and 24, with `color`, string `rotate` and `label`.
  - `vendor-icons.test.ts`: aborts on a `<g>`, a `<script>`, a non-`d` path attribute, a root attribute outside the allowlist, `url()` in path data, and no paths.
  - `base-css.test.ts`: each notch token equals the 20-point formula; `--ul-static` decodes to the spec recipe and can fetch nothing; the reduced-motion block carries all four declarations.
  - `theme-vars.test.ts`: an owned token built by interpolation is now reported.

## Decisions and deviations
- **Icons vendored:** 19 Pixelarticons at v2.4.0 (`9e6658cd…`). Each SVG's bytes are checked against the git blob id GitHub lists for its path at that commit. The LICENSE blob (`4be35e8f…`) matches too.
- **The licence sits in `core/`, beside `icons.ts`.** The change map said `icons/`, and there is no such directory. plan.md is updated.
- **Ghost scanner hardened.** The skip for `var(--x-${…})` existed only for the old Icon.vue. With the explicit colour map it has no user, so an interpolated owned token now fails instead of passing unchecked.
- **Focus ring moved into `base.css`.** `a:focus-visible, button:focus-visible` now use `--ul-focus`; app.css's copy was deleted. It must follow the `a:focus` reset, which has the same specificity. Scope is unchanged (links and buttons only), so inputs get no new ring.
- **`--ul-scrim-fill` is theme-independent**, void at 0.85 in both themes. Today's overlay is black at 0.7 in both themes too.
- **Motion tokens hold duration plus stepped timing** (`90ms steps(3)`), so they drop into `transition`/`animation` shorthands. `--ul-cursor` is `1060ms steps(1, end)` for an on/off blink. The decode token stays out; it is a follow-up.
- **The reduced-motion rule needs `!important`.** The universal selector has zero specificity, so without it any component class with its own `animation` wins. Biome's `noImportantStyles` is suppressed for exactly those four lines, with the reason.
- **No `;` inside `--ul-static`.** `theme-contrast.ts` splits declarations on `;`, so the URI is `data:image/svg+xml,` with no charset parameter.
- **Interim colour map:** `inverse` → `var(--txt-inverse)` and `white` → `var(--txt-white)`. Both are aliases, so phase 7's contract makes the ghost guard force their final mapping.

## Attempts
- **Anonymous GitHub API rate limit.** The first `vendor-icons.ts` run died on `tree.tree.map` because the anonymous API returned 403 (0 of 60 left). The tree now comes from `gh api`, which uses the existing login, and raw fetches check `res.ok`.
- **Biome reflowed the polygon tokens across lines.** The notch test normalises whitespace, including the space after `polygon(` and before `)`.
