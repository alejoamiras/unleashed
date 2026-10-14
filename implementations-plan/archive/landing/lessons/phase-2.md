# Phase 2: the page as drawn, and the browser smoke

Gate: the fast gate, `bun run build:landing` (guard inside) and `bun run --cwd apps/landing test:browser`: 14 passed,
1 skipped (live only). Unit tests: 27.

- **The no-JS sheet must win on specificity.** `<noscript><link rel="stylesheet" href="/noscript.css"></noscript>`
  sits above the stylesheet Vite injects, so `.screen{display:none}` lost to the page's `.screen{display:block}` on
  order. `.idx .screen` wins on specificity. The no-JS smoke caught it.
- **The overlap check bites.** With the narrow-phone rule removed, the 320 and 360 px cases fail; with it, they pass.
  The check measures the name's text through a Range, because the grid cell spans the column whatever the text does.
- **A fetch from the page is a CSP violation.** `default-src 'none'` covers `connect-src`, so the missing-file case
  uses Playwright's request context (no `Sec-Fetch-Mode: navigate`) and the unknown-page case a real navigation.
- **Side by side with the board** (`design/s-c-dark.png`, `s-c-light.png`), at 1140 px with reduced motion: the nav
  panel, wordmark, copy panel, rows, tags, caveat and footer line up; the differences are the listed ones (no outer
  stage notch, the dither and the screens not drawn yet). At 390 px the tags sit under the names, as on the card board.
- **WebKit cannot launch on this host.** `playwright install webkit` downloads `webkit-2359`, but launching it needs
  `libgtk-4-1`, a system package (`sudo apt-get install libgtk-4-1`). Installing it is a host change outside this
  task, so the local WebKit gate is blocked here and goes to the owner. Chromium covers every case meanwhile.
- **The nav's notch is inherited on the board.** `.l-nav` sets no `--ul-fill` or `--ul-notch`; on the board it took the
  stage's panel fill and 6 px notch. The landing states both, since `.land` is no longer inside a stage.

LESSONS_FILE=implementations-plan/landing/lessons/phase-2.md
