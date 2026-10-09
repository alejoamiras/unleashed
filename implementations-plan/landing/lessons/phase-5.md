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

## Post-implementation Codex loop

Session `01a12291-ac25-7e13-a1fc-1c62ededdf38`, gpt-6.1-sol at high, over `9725c08..HEAD` without
`implementations-plan/`, with the plan's adversarial ask and its two rules verbatim.

Round 1: material findings remain. Seven findings, all verified against the code, all adopted.

| # | Finding | Disposition |
|---|---|---|
| 1 | `distDigest` framed files with NUL separators, so a file's bytes could pose as a boundary and two artifacts could share a digest | Adopted: every part is length-prefixed; a regression case pins it |
| 2 | `verify-build.ts` skipped symlinks, which wrangler follows and uploads, so a symlink could ship unseen by the digest | Adopted: any entry that is not a plain file or directory fails the guard (checked by hand with a planted symlink) |
| 3 | `--expect` or `--channel` with no value silently skipped its check | Adopted: each flag once, with a value of the right shape; unknown arguments fail (`verify-build.test.ts`) |
| 4 | The smoke server sent 404 for an unmatched non-navigation request; an assets-only Worker in SPA mode sends `index.html` with a 200 for every unmatched request | Adopted after checking Miniflare 4.129.1's asset worker (`notFound` ignores the request mode) and Cloudflare's SPA routing page. Server and spec now expect the fallback, with page headers and no long cache. Inference 12 is refuted |
| 5 | The link allowlist matched only lower-case, double-quoted `http(s):` values; `//host`, `HTTPS:`, `https&#58;` and single quotes passed | Adopted: every destination attribute must be an allowed URL or a plain local path; a `content` value that could name a place must be allowed. Five bypass cases pinned |
| 6 | Only frame steps were guarded: a theme redraw or a resize of a failing engine threw uncaught and left its screen up; an engine joined the set before its first draw | Adopted: `Loop.guard` covers starts, resizes and redraws; one page-owned `ResizeObserver` replaces the per-engine ones, so a retired engine is unobserved; a browser case breaks a screen's `fillRect` and shows both paths retire it (it fails with the redraw guard removed) |
| 7 | Two comments carried workflow history ("while the owner's pick is pending", "Not on the board") | Adopted: each keeps only its lasting reason |

Round 2 (resumed, over the fix commits): material findings remain. Three findings, all verified, all adopted.

| # | Finding | Disposition |
|---|---|---|
| 1 | Browsers also split attributes on `/`, so `<a/href="//evil.example">` passed the link check | Adopted: the attribute match accepts `/` as a separator; a regression case pins it |
| 2 | A meta refresh could still leave the page: `url=http:evil.example` and `url=&sol;&sol;evil.example` passed | Adopted: any meta refresh fails the guard (the page has none), and a `content` value with `:`, `&` or `//` must be an allowed URL |
| 3 | A retired field kept its `pointermove` listener, which still reached the host and held the engine | Adopted: `Engine.dispose` (optional) lets go of it, and `retire` calls it; checked by hand: after a forced draw failure the canvas is hidden and a pointer move makes no call |

Round 3 (the plan's last round): material findings remain. Two findings, both verified, both adopted.

| # | Finding | Disposition |
|---|---|---|
| 1 | An attribute right after a closing quote (`id="x"href=…`) and SVG's `xlink:href` passed the link check | Adopted: an attribute may start after whitespace, `/` or a quote, and `xlink:href` is a destination; both pinned |
| 2 | `http-equiv="re&#102;resh"` passed, because the browser decodes the value and the check read its spelling | Adopted: any `http-equiv` fails, and any character reference other than the five the renderer emits fails, so no reference can spell a `/` or a `:` |

Three rounds found nine ways past a regex reading of HTML. The class has no end short of a real HTML
parser, which the guard cannot import beside the token. The guard now says what it is: a check against a
link nobody meant to ship, not the tamper boundary, because code that runs at build time could navigate
from the script bundle, which no HTML check sees. The deploy's boundary is the digest of a reference
build. The cap was reached, so the scope call went to Codex as a consult (below) rather than a fourth
audit round.

LESSONS_FILE=implementations-plan/landing/lessons/phase-5.md
