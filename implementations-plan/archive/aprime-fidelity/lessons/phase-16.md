# Phase 16 — Card anatomy, intro and footer

## What was done

- **Card.** `D:ui/Card.vue`'s root is an `<article>`; it has one consumer, so no `as` prop (G138).
- **Token card.** `TokenCard.vue` names its article with `aria-labelledby` pointing at an `<h2>` whose id comes from `useId()`. The h2 is the body font 700 26 with `--ul-tracking-heading` (G21). A header row holds the h2 and the `DisclaimerTag` opposite it (flex, space-between, gap 12, wrapping with an 8px row gap on a narrow card); the chip's old footer and its comment are gone (G22). "Fixed drip:" is its own row at 14 ink-2 with the amount Mono 700 14 ink; the card's own 16px gap spaces the rows (G136). The connect hint and the status row carry a `.bottom` class with `margin-top: auto`, so a card stretched by the grid pins them to its foot.
- **Intro, grid and footer.** `DripView.vue`'s testnet intro reads "…mint fixed test tokens into a public or private balance. Internal drip. No real value." at max-width 640px, line-height 1.5 (G137; the dormant mainnet branch is untouched). The grid gap is 24 with `align-items: stretch`. `<Footer />` mounts after `.cards`, so the view's own 24px gap sets it under them. `Footer.vue` is one flex-wrap row (space-between, gap 12, 13px ink-3): "Contracts: SIGNAL · NOISE · Dripper" left, SIGNAL and NOISE in Mono, the contract links in accent with a dotted underline at offset 4; "Wonderland aztec-standards · Aztec Network" right, still links (dotted, ink-3). The tagline is gone on both networks, so the component no longer reads `IS_MAINNET`. `rel="noopener noreferrer"` and the plain-text fallback (no explorer URL ⇒ `<span>`) are kept. `AppShell.vue` drops the faucet footer: the bridge footer now renders `v-if="section !== 'drip'"`, i.e. exactly where it rendered before (G76).

## Tests

- `Card.test.ts`: the tag assertion is `ARTICLE`.
- `TokenCard.test.ts`: a new case, the card root is an `ARTICLE` whose `aria-labelledby` equals its h2's id, and the h2 reads "SIGNAL". `:85-95` ("Fixed drip: 1,000 SIGNAL", the disclaimer text) pass unchanged.
- `Footer.test.ts`: the tagline case is inverted to "no tagline on either network" (none of the testnet or mainnet tagline phrases); the Wonderland link and no-anchor fallback cases are unchanged.
- `AppShell.test.ts` (not named by the plan, but its faucet case pinned the shell-mounted faucet footer): the `Footer.vue` mock is gone and the faucet case asserts no bridge-footer marker and no `<footer>` element in the shell; the view is mocked, so a footer there could only come from the shell.
- `DripView.test.ts`: the view's own `<footer>` is the element right after `.cards` and reads "Contracts:" (fails with the mount removed, checked).
- `Footer.test.ts` also gains an explorer-linked case: three contract anchors with `target="_blank"` and `rel="noopener noreferrer"`, reading "Contracts: SIGNAL · NOISE · Dripper".

## Attempts and notes

1. Vue's whitespace `condense` keeps " · " between the contract links because each separator is a text node with a visible character; the credit link's text sits on one line so no condensed space is underlined.

## Deviations from the plan

- None in behaviour. `AppShell.test.ts` changed although the phase's test list does not name it; the assertion it pinned (the faucet footer mounted by the shell) is exactly what the phase removes.

## Validation gate

Run, and PG again after the verifier's test additions (tools 1563; everything else identical):
- `bun run lint` exit 0 (Biome: the pre-existing 1 warning and 2 infos; complexity-baseline check OK).
- `bun run typecheck:all` exit 0 (design, bridge-core, tools).
- `bun run test:all` exit 0 (design 236; bridge-core 451 + 1 skipped; tools 1561 in 106 files).
- `bun run --cwd apps/tools test:e2e` exit 0 (30 tests).
- Baseline: `git diff --exit-code <rev> -- scripts/complexity-baseline/manifest.json` exit 0; `git diff --stat <rev> -- scripts/` empty.
- `agent.sh specs/drip.spec.ts` exit 0: 4 passed (3.1m): public and private drips land and the balances follow; add-to-wallet fails open to `unsupported` on plain and selfpay; `ok` on full removes the button. The run stopped its own sandbox by pgid.

No tour in this phase; arc 6's tour runs at phase 18.

## Verifier

A fresh general-purpose reviewer read the plan and the phase diff, compiled `Footer.vue` to check the rendered text, and measured the header row in headless Chromium with the repository's fonts. No high findings.

- **Medium, accepted:** nothing proved the faucet still had a footer. Deleting the `<Footer />` in `DripView.vue` left every gate green, and the AppShell test title ("its view mounts its own") and the commit message claimed more than the assertion did. Fixed with the `DripView.test.ts` case and the `<footer>`-free shell assertion above. The reviewer proposed asserting that the shell's `.foot` wrapper is empty; that wrapper goes once the bridge footer moves to the form steps, so the test asserts on footer elements instead.
- **Low, accepted:** the contract links' `rel`, `target` and separators were unpinned because the whole file mocked the explorer to "". Covered by the new Footer case.
- **Low, recorded:** the header row wraps unevenly in a narrow band. The SIGNAL row needs about 296px (h2 94 + gap 12 + chip 190) and NOISE about 280px. Inner card widths are 370 at 1440, 332 at 1100 and 310 at 390, so no tour width wraps. With the desktop dock open (300px), viewports of about 1252–1283px leave 280–296px, so SIGNAL's chip drops to a second line and NOISE's does not, and their rows sit 36px apart. No cheap CSS fix avoids wrapping the chip inside itself. Flagged.
- **Low, done here:** this lessons file and the ✓ on the phase heading.

## Flags for owner sign-off

- The credits ("Wonderland aztec-standards · Aztec Network") stay links, dotted in ink-3, where the board draws plain text.
- The uneven header-row wrap between 1252 and 1283px with the dock open (above).
- The intro copy ("test tokens") and the footer without a tagline are recorded decisions (OQ25 A, G76), shown in the arc 6 tour.
