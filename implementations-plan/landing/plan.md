---
plan: landing
tier: mid
driver: claude-code
claude_model: opus
codex_model: sol
code_review: off
explainer: off
eli5_mode: artifact
budget: "recon 1 agent; code_review off; codex gpt-6.1-sol at high; fable leg on opus"
harden: not scheduled (a static page with no secrets, no input and no backend)
status: conditionally approved; phases 1-5 built, deploy decisions pending
---

# Landing page for unleashed.systems

Ship option C, "Dither tide", from the owner's landing board as the page at `unleashed.systems` and
`www.unleashed.systems`, with one small motion engine on each experiment row. A new assets-only
Cloudflare Worker serves it, Workers Builds deploys it from `main`, and the dashboard redirect rule
that sends both hosts to the testnet app goes away.

## Phase 0 answers (from the owner, relayed by the main session)

- **Tier**: `mid`. Rubric: external coupling is high (the Cloudflare dashboard and a cutover on the
  apex). Blast radius, irreversibility and security are low to moderate: a static page, and a
  cutover that one toggle reverses. Novelty is low: the same pattern as the two app Workers. Migration
  cost is none.
- **Budget**: recon 1 agent; `code_review: off`; `claude_model: opus`; `codex_model: sol`
  (`gpt-6.1-sol`, Codex CLI 0.160.0); `explainer: off`; `eli5_mode: artifact`; `/harden` not
  scheduled.
- **Scope**: "C + per-card engines". Option C as drawn, copy included, plus a small engine on each
  experiment row. The engines were never drawn, so they go to the owner as a design board before
  any card code is written.
- **Sign-off on option C**, quoted: "Yeah, please blueprint doing C and publishing to prod including
  connecting cloudflare's dashboard."
- **Cloudflare**: "Keyed deploy + your clicks". The lead creates the Worker once through a keyed run
  and verifies it on `workers.dev`. The owner then does the dashboard-only steps from the runbooks
  below.
- **Merge authority**: "Lead merges when green". The lead squash-merges its own PRs once every
  required check is green and the Codex fix loop has converged. Never `--admin`, never a bypassed
  check, never a change to branch protection.
- **Success**: `https://unleashed.systems` and `https://www.unleashed.systems` serve the C landing
  with the approved card engines, from a new assets-only Worker that Workers Builds deploys from
  `main`. The redirect rule is gone. Every link works. CI gates the landing (lint, typecheck, unit,
  build, browser smoke). The lead verifies it live in a real browser in both themes, at phone and
  desktop width, with reduced motion and with Pause motion.
- **Out of scope**: the tools app's behaviour, the mainnet app and its Access policy, the two
  existing Workers, new experiments, analytics or tracking of any kind.
- **Open work** goes to `implementations-plan/follow-ups.md`, per this repository's AGENTS.md.

## Owner verdict (approval gate)

**Conditional approve** for building the landing now; the deploy decisions come later. The owner,
verbatim: "my picks are B2, F1 and N1. A5: yes, let's do preview builds. Im going into the weekend
though, I think I'll answer the other ones later. But mosr have to do with how are we going to
deploy, so maybe you can already start implementing the landing and we do the deploy and rest
afterwards"

What it settles and what it leaves open:

| Ask | State |
|---|---|
| A1 engines | **Picked**: B2 Both ways, F1 Drip, N1 Tuner. The placement was not picked: the page builds Strip, the recommendation, as **provisional, awaiting the owner**. Switching to Tile is one constant and its CSS, because every engine lays out from its canvas size |
| A2 narrow phones | **Awaiting owner sign-off**: built as recommended |
| A3 page details | **Awaiting owner sign-off**: each recommended default built as listed |
| A4 tokens | **Unanswered**: K1 and O1 do not start |
| A5 previews | **Changed to yes**: the landing Worker gets preview builds (D9) |
| A6 zone features and NEL | **Unanswered**: O2 does not start |

Scope until the owner returns:
- Phases 1 to 5, then the Post-implementation Codex fix loop on that diff, then PR 1 opened so CI
  runs.
- Nothing merges. The merge authority above is suspended until the owner returns. The owner said
  the deploy comes afterwards, and AFK mode forbids merges anyway.
- PR 1 lists every provisional choice and every surface awaiting sign-off.
- The owner is away, so AFK rules apply. Non-trivial forks go to `/codex` (`gpt-6.1-sol`, high), and
  each consult is logged in the phase's lessons file.

## Outcome & Quality Bar

**For whom.**
1. Someone who arrives from a link (an X post, the Aztec forum, a teammate) on a phone or a laptop
   and decides in about ten seconds whether to open an experiment.
2. The maintainer who adds experiment 3 later.

**What excellent looks like.**
1. **The page requests nothing from another origin.** Fonts are self-hosted. There is no analytics,
   no cookie and no storage. A strict CSP (`default-src 'none'`, no `unsafe-inline`) reports zero
   violations in a real browser. On the live hosts, the served HTML is byte-identical to the build,
   and no `/cdn-cgi/` request happens. The one out-of-band exception is the zone's own Network Error
   Logging: on a failed load, the browser reports it to Cloudflare, which already hosts the page
   (Ask A6).
2. **The dither is crisp and cheap.**
   - Cells are 4 CSS px squares. They are whole device pixels, so exactly square, at DPR 1, 1.25,
     1.5, 2 and 3. At other zoom levels they vary by one device pixel, as on the board.
   - The field steps once every 150 ms.
   - It stops when the tab is hidden or when the visitor presses Pause motion. Card screens also
     stop when scrolled away. When nothing can run, the page requests no animation frames.
   - Reduced motion shows one still frame. Pause motion stops every engine on the page.
3. **Text is readable in both themes.**
   - Every line of copy sits on a solid token fill (the board's rule).
   - This holds in Channel (dark) and Printout (light), at 360, 390, 1440 and 1920 px.
   - No width scrolls sideways, and nothing overlaps.
   - Every link and the Pause button can be reached with Tab, and each shows a focus ring.
4. **Adding an experiment is mostly data.**
   - The maintainer adds one entry to `src/content.ts`. The build renders its row, tags and link.
   - An entry can use an existing engine or none. A new engine is code.
   - A link outside `LINKS` fails a unit test, so a new destination is a deliberate edit to `LINKS`.

**Good enough.** Fidelity with the board at the board's own widths, checked by eye, not by an
automated diff. These are left out, because each needs a drawing, an owner decision or a tools change
first: a 404 page, a social image, a theme control, deep links into the app.

## Visible surfaces (UI sign-off list)

AGENTS.md: a change to what a user sees is the owner's decision. Every surface this plan ships:

**As drawn on the board (signed off with option C):**
1. Nav: the lockup (8×8 mark and the "Unleashed" wordmark); "Faucet" and "Source" text links; the
   small "Open the app" button. The text links hide below 600 px, as drawn.
2. Hero: the pixel wordmark with its converge animation; the heading "Privacy nobody can switch off,
   tested in the open."; the lede; "Open the bridge →" and "View source ↗".
3. Experiments: the header "Experiments" with "Two on testnet. The next one is in the lab."; the rows
   Bridge, Faucet and Next with their tags and copy; rows invert on hover and focus.
4. The caveat note "Experiments, not products."
5. Footer: lockup, "Source on GitHub", "Apache-2.0", "Works with any Aztec wallet", "Mainnet is not
   open yet", and the "Pause motion" / "Play motion" button. Under reduced motion the button starts
   as "Play motion", and pressing it runs the motion (the board's behaviour).
6. Background: the Dither tide field, with the pointer trace on desktop.
7. Themes: Channel and Printout, chosen by the operating system. The board's Channel/Printout toggle
   is board chrome, so the page has no theme control.

**Not on the board, so the owner decides (Asks A1-A3):**
8. The card engines and where their screen sits in each row (the card-engine board).
9. Narrow phones: below about 400 px, the tags drop under the experiment's name. On the board they
   overlap it at 360 px.
10. The browser tab title, the favicon, and the text a link preview shows. There is no preview image.
11. What an unknown path shows (`unleashed.systems/anything`), and `www` serving the same page.
12. Text can be selected (the app turns selection off). Scrollbars stay hidden, as everywhere in the
    app (`base.css`).
13. Without JavaScript:
    - The page shows all its text and links, still.
    - It is always Channel (dark), because the theme is chosen by a script.
    - The card screens are hidden, and the Pause button is absent.
14. Wide screens above the board's ~1160 px stage: the copy stays left-aligned as drawn, and the field
    and its signal band fill the rest of the width.
15. The pointer trace under Pause motion or reduced motion. The board still draws it there; the plan
    does not, because a trace that follows the pointer is motion.
16. The wordmark appears once its pixel font has loaded, at most about 1.5 s after the page. The
    board has the font inlined, so it never waits.
17. A card engine that fails to start (no canvas context, a script error) leaves its row without a
    screen, as without JavaScript. A card font that fails to load draws in the fallback face.
18. Preview builds (A5): the same page at a workers.dev preview host, which tells search engines not
    to index it.

**Not shipped from the board**: the option tabs, Desktop/Phone and Channel/Printout toggles, the
notes, the comparison table and the verdict; the stage's outer notched corners.

## Card engines (picked by the owner; placement provisional)

Board: https://claude.ai/artifact/BjzP75ugjcxiutFRjo7cFq (source:
`implementations-plan/landing/design/cards.src.html`, fonts stripped). Every candidate runs live on
option C, in both themes and at both widths.

| Slot | Candidates | Recommendation | Owner's pick |
|---|---|---|---|
| Placement | Strip (a 48 px screen across the row, under its copy) · Tile (a 216×72 screen at the row's right on desktop, a strip on phones) | Strip | none yet: Strip is built, provisional |
| Bridge | B1 Portal (option B's lanes in miniature) · B2 Both ways (sends veil past the bar, exits clear again) · B3 Veil (one amount, a static sweep) | B1 Portal | **B2 Both ways** |
| Faucet | F1 Drip (a tap drips SIGNAL and NOISE as coins that roll into the account) · F2 Two taps (one named tap per token) · F3 Rain | F1 Drip | **F1 Drip** |
| Next | N1 Tuner (a scan line looks for a signal) · N2 Off air (one still frame) · N3 Assembly (the mark builds cell by cell) | N1 Tuner | **N1 Tuner** |

Rules every screen keeps:
- It is `aria-hidden` decoration inside the row's link.
- It steps on the page's single clock, at 7 to 14 steps a second.
- It stops when hidden, off screen or paused, and shows a still frame under reduced motion.
- It uses static only as the veil over an amount.
- It keeps its own panel fill, so the row inverts around it on hover.

Card code is written only after the owner's pick. Phase 4 builds exactly the three picked engines.

## Architecture & Implementation

### Proposed architecture

A new workspace, `apps/landing` (`@unleashed/landing`): Vite 8, vanilla TypeScript, no framework
runtime. The page body is rendered to static HTML **at build time** from typed content, so the first
frame is complete without JavaScript. The runtime script only runs the canvases and the Pause
control.

- **Why not Vue.** The repository's apps are Vue, but this page has no state, no shared components
  and one button. A Vue runtime would ship about 30 KB to render static text. A build-time Vue render
  could reuse design components, but the design package has no Tag, Button or Note component whose
  markup matches the board's landing classes, so it would add a renderer for nothing reused.
- **Why build-time rendering, not hand-written HTML.** Icons and the mark come from the design
  package as data, not as pasted path strings. One content file drives the rows, tags, links and
  engine slots, and a test pins the link allowlist. Both audits kept this over the competing outline.

```
apps/landing/
  package.json            @unleashed/landing; scripts dev, build, preview, typecheck, test,
                          test:browser, verify:build, worker:deploy, worker:preview
  index.html              static head (title, meta, canonical, theme boot, favicon, noscript
                          stylesheet); <!--landing:body-->
  vite.config.ts          one plugin (body render, font preloads, _headers, build id), woff2 never
                          inlined, modulePreload polyfill off, preview headers
  security-headers.ts     the one source of the response headers (CSP and the rest)
  wrangler.jsonc          assets-only Worker "unleashed-landing"
  public/theme-boot.js    classic pre-paint script: <html theme> from prefers-color-scheme,
                          <html class="js"> for the font gate
  public/noscript.css     hides the card screens when scripts are off
  public/favicon.svg      byte-identical to apps/tools/public/favicon.svg (pinned by a test)
  scripts/dist-checks.ts  pure checks over a built dist/, and its digest
  scripts/verify-build.ts the offline build guard's entry point; prints DIST_SHA256
  scripts/worker.ts       Workers Builds' deploy commands; each refuses the other channel's dist/
  README.md               commands, layout, hosting, the placement switch
  src/
    content.ts            LINKS, COPY, EXPERIMENTS (typed data)
    markup.ts             pure render functions (escape, icon, mark, page sections)
    main.ts               runtime boot: font gate, motion, engines, Pause button
    motion.ts             pure motion state and Ticker
    styles/landing.css    option C's rules, on top of @unleashed/design/base.css
    engines/
      engine.ts           canvas host: sizing, palette, ResizeObserver, IntersectionObserver
      loop.ts             the one rAF loop: steps each runnable engine on its own tick, idles when none can run
      dither-field.ts     pure: Bayer 4×4 thresholds, the field value, the cell colour
      dither.ts           the page background
      card.ts, draw.ts    the card canvas host and the drawing helpers the three share
      both.ts, drip.ts,   the picked card engines: a pure model (layout, step, draw) each
      tuner.ts
      registry.ts         EngineId to model
  tests/server/           the in-process static server and its strict _headers parser
  tests/browser/          playwright.config.ts, global-setup.ts, fixtures.ts, page, worker, motion
                          and cards specs, tsconfig.json
packages/design/src/core/mark.ts   MARK_INK and MARK_SIGNAL path data (new; pure TS)
```

### Key interfaces

```ts
// src/content.ts
export const LINKS = { app: "https://testnet.app.unleashed.systems", source: "https://github.com/alejoamiras/unleashed" } as const
export type TagKind = "live" | "private" | "lab"
export type EngineId = "both" | "drip" | "tuner" // the owner's picks; the registry maps each to a class
export interface Experiment {
	readonly name: string
	readonly href: string | null // null renders the open slot (a div, not a link)
	readonly tags: readonly TagKind[]
	readonly description: string
	readonly engine: EngineId | null
}
export const EXPERIMENTS: readonly Experiment[]

// src/markup.ts — pure, no DOM; every text and attribute goes through esc()
export function renderBody(content: PageContent): string

// src/engines/engine.ts
export interface Engine { readonly tick: number; visible: boolean; fit(force?: boolean): void; step(): void; draw(): void; retheme(): void }

// src/motion.ts
export class Ticker { constructor(tickMs: number); advance(dtMs: number): boolean } // at most one step per frame; dt clamped to 250 ms
export interface MotionState { reduce: boolean; userChoice: "play" | "pause" | null; hidden: boolean }
export function playing(s: MotionState): boolean // userChoice wins over reduce; null follows !reduce
export function shouldRun(s: MotionState, visible: boolean): boolean
```

### Data and control flow

1. **Build.** `vite build` loads `vite.config.ts`. One plugin does four jobs:
   - In `transformIndexHtml` (`order: "post"`), it writes `renderBody()` into the body. It adds
     `<link rel="preload" as="font" type="font/woff2" crossorigin>` for Atkinson Next and the
     Sixtyfour subset, from `ctx.bundle`'s hashed names. It adds `<meta name="unleashed-build">`: the first 8 hex characters of
     `WORKERS_CI_COMMIT_SHA`, else of `git rev-parse HEAD`, else the build fails.
   - In `generateBundle`, it emits `_headers`: the `/*` rules from `security-headers.ts`, plus one
     `Cache-Control: public, max-age=31536000, immutable` rule per emitted hashed file.
   - CSS imports `@unleashed/design/base.css`, whose woff2 files Vite hashes into `dist/assets/`,
     never inlined.
2. **First paint.** `theme-boot.js` (classic, render-blocking, same origin) sets `<html theme>` from
   `prefers-color-scheme` and adds `class="js"`. The static HTML and CSS paint the whole page.
   Without scripts, `<noscript><link rel="stylesheet" href="/noscript.css"></noscript>` hides the
   card screens.
3. **Boot** (`main.ts`, a module). Its steps, in order:
   - Wait for `document.fonts.load()` of the Sixtyfour face, at most 1.5 s, then add `fonts-ready`.
     CSS keeps the wordmark `visibility: hidden` under `.js:not(.fonts-ready)`, and runs `converge`
     only under `.fonts-ready`.
   - Read the palette from the computed tokens, and build the loop.
   - Load the canvas fonts (`document.fonts.load` for each face an engine draws text in) before the
     first layout of a card engine. Every font wait is bounded at 1.5 s and catches its rejection;
     on either, the engine draws in the fallback face.
   - Add the dither (host: the page wrapper) and one card engine per `canvas[data-engine]`. Each
     engine starts inside its own `try`. One that throws, or whose `getContext` returns null, hides
     its screen and drops out of the loop; the links, the other engines and Pause keep working.
   - Reveal and wire the Pause button.
   - Listen for `prefers-reduced-motion`, `prefers-color-scheme` and `visibilitychange`.
4. **Each frame.** The loop computes `dt`. For each engine where `shouldRun` holds, the engine's
   `Ticker` decides whether to step; a step runs `step()` then `draw()`. When no engine can run, the
   loop stops requesting frames, and the next state change restarts it. A theme change redraws every
   engine once, even when paused.

### Algorithms and non-obvious mechanics

- **Dither at cell resolution, exact cells.** The board draws a cols×rows offscreen image, scaled ×4
  into a canvas sized at the device pixel ratio. That is about 34 MB of backing store for a
  1440×1500 page at 2×. The landing's canvas is cols×rows itself (`cols = ceil(w/4)`). Its CSS size
  is set through CSSOM to exactly `cols·4 × rows·4` px, inside the `overflow: hidden` host, with
  `image-rendering: pixelated`. A CSS width of 100% would stretch `ceil(w/4)` cells over `w` and
  make the cells unequal. The field function, the Bayer matrix and the 150 ms step stay the board's.
- **Field math.** The board's function, unchanged:
  `v = 0.1 + 0.12·sin(x·0.011+φ)·sin(y·0.017−0.7φ) + 0.08·sin((0.6x+y)·0.009+1.3φ) + band(x)`.
  - `band` rises as `((x−e₀)/span)^1.5·1.08` right of `e₀ = 0.56w` (`w−72` below 640 px).
  - A cell is signal when `v > 1`, line when `v > (B+0.5)/16`, else background.
  - Pointer heat adds `0.6·heat·(1−d/110)` within 110 px, and decays ×0.7 a step.
  - Touch pointers, Pause and reduced motion all leave the trace off.
- **One clock.** Per frame each engine's `Ticker` adds `dt` (clamped to 250 ms). When the sum reaches
  the tick, it steps once and keeps at most one tick of debt, so a slow frame never runs a burst.
- **Stop conditions.** `playing()` is the visitor's last Play or Pause choice if there is one, else
  `!reduce`. A media-query change therefore never undoes a manual Pause. `hidden` follows
  `document.hidden`. `visible` is each canvas's IntersectionObserver state; the dither's host is the
  whole page, so only the tab's visibility stops it.
- **Palette.** Engines read `--ul-*` from `getComputedStyle(document.documentElement)` at boot and on
  every theme change. No colour literal appears in engine code except the four fixed grey levels of
  static (the same levels as `--ul-static` and option B).
- **Live integrity check.** The live smoke fetches `/` and compares it byte for byte with
  `dist/index.html` built at the same commit (the build id meta proves the commit). It fails on any
  `/cdn-cgi/` request or any `<script>` not in the build, so a same-origin script injected by a zone
  feature cannot hide behind `script-src 'self'`.

### File-level change map

| Path | Change |
|---|---|
| `apps/landing/**` | new (above), including `README.md` |
| `packages/design/src/core/mark.ts` | new: the mark's path data. A landing test pins it against `AppShell.vue`'s `MARK_INK` until AppShell imports it (follow-up; `lifi-routing` is editing AppShell now) |
| `package.json` | `dev:landing`, `build:landing` |
| `bun.lock` | the new workspace (versions already locked; no new package) |
| `scripts/ci-cd/workspaces.test.ts` | add `@unleashed/landing` |
| `scripts/ci-cd/behavior-gating.test.ts` | `APPS` gains `landing`; `assertGraphCovered` for the landing filter; pin `_build-landing.yml` and `needs-landing-build` |
| `.github/workflows/pr-quick.yml` | `landing` filter, `needs-landing-build` output, `build-landing` job, read by `quality-status` |
| `.github/workflows/_build-landing.yml` | new reusable: build, guard, Playwright smoke (Chromium) |
| `apps/tools/cloudflare.env.example` | header comment: "the Workers", not "the two Workers" |
| `implementations-plan/.gitignore` | `**/design/*.png`: board screenshots stay local |
| `implementations-plan/landing/design/*.src.html` | committed: the two boards' sources, fonts stripped, as the design record |
| `README.md`, `AGENTS.md`, `packages/design/README.md` | docs, in PR 2 (after the cutover) |

`.github/actions/setup-playwright` stays as it is: CI's full install already provides tools'
Playwright 1.63.0, the same pin, and `behavior-gating.test.ts` holds the two pins equal. The
`workflows` filter covers `.github/actions/**` and already feeds `needs-landing-build`, so the
landing filter does not list the action again.

### Trade-offs and alternatives not taken

- **Hand-written `index.html` and a static `public/_headers`** (the competing outline below). A smaller
  diff, but it pastes icon and mark paths, splits one experiment across three places, and keeps a
  static `_headers` that cannot carry one cache rule per hashed file.
- **A third build target inside `apps/tools`.** It would reuse the pipeline but drag in the Aztec
  dependency graph, COOP/COEP and a CSP built for the app. Rejected.
- **`www` as a 301 to the apex.** An assets-only Worker cannot redirect by host (`_redirects` matches
  paths only). That leaves a new dashboard redirect rule or a Worker script. This plan removes a
  dashboard rule, so it serves both hosts from the same Worker and points
  `<link rel="canonical">` and `og:url` at the apex.
- **Workers routes instead of custom domains.** Routes ride the existing proxied records, so no DNS
  change at all. The repository's pattern is custom domains (Production only), and the dashboard
  replaces an existing record in one step. Routes are the fallback if it refuses.
- **Previews (the owner's call, A5).** `preview_urls: true`, and Workers Builds builds every
  non-production branch.
  - The build tells a preview from production by `WORKERS_CI_BRANCH`: set and not `main` means a
    preview. A local or CI build has no branch variable, so it is production.
  - A preview build adds `X-Robots-Tag: noindex` to every response and
    `<meta name="robots" content="noindex">`, so search engines never index a preview host.
  - `dist/build.json` records `{ buildId, channel }`. `worker:deploy` refuses a preview build, and
    `worker:preview` refuses a production one. K1's guard takes `--channel production`.
  - A preview uploads with `wrangler versions upload` and no alias of its own. It is served at its
    version URL, plus whatever branch alias Workers Builds gives it. Unlike the tools app, nothing on
    this page trusts its host, so an alias collision costs nothing.
- **`not_found_handling: single-page-application`.** An unknown path shows the landing. That is the
  closest to today, where every path reaches the app, and it needs no undrawn 404 page (Ask A3).
- **The smoke's server.** Playwright's global setup serves `dist/` from an in-process `node:http`
  server bound to port 0. It is not a Worker emulator. It implements only the `_headers` subset the
  build emits (exact paths and `/*`, headers of matching rules combined) and throws on any other
  syntax. It serves `index.html` with a 200 for any unmatched request, as an assets-only Worker does.
  The live smoke checks the real Worker gives the same answers. The owning process holds the socket
  from bind to teardown, so no port can race and nothing is left to reap. `vite preview` keeps the
  same headers for manual runs.
- **WebKit.** Chromium in CI, to keep the required check short. WebKit at phone size in the local and
  live gates of phases 2-4 and 7. Linux WebKit is not iOS Safari, so the owner opens the live page on
  an iPhone once at the cutover.

## Security & Adversarial Considerations

- **Threat model.** A static page with no input, no backend, no cookies and no storage. The attack
  surface:
  1. the build supply chain, through Workers Builds and its token;
  2. the keyed run's token;
  3. the Cloudflare account, and the dashboard's DNS and rules;
  4. script injection into the page, by zone features or a compromised dependency;
  5. links that point somewhere else;
  6. framing.
- **Least privilege.**
  - GitHub Actions keeps `contents: read` and no Cloudflare credential. The new job has no job-level
    permissions (`behavior-gating.test.ts` pins this).
  - Workers Builds gets a new user token with the per-Worker **Editor** role on `unleashed-landing`
    only. Cloudflare's Workers roles page (updated 2026-09-15) says Editor can deploy an existing
    Worker. The owner creates this token in the dashboard; no agent sees it. If Workers Builds
    refuses it, the fallback is the existing account-wide build token, with the residual already
    accepted in `follow-ups.md` (Inference 6).
  - Creating a Worker needs product-level Admin or the legacy Workers Scripts Edit permission. So the
    keyed run keeps the existing template's token: Workers Scripts Edit and Account Settings Read on
    one account, a TTL of hours, IP-filtered.
- **The keyed process runs as little code as possible.**
  - The lead installs, builds and guards before filing the request, and the guard prints the dist
    digest.
  - The keyed command runs two entry points directly, never through `bun run`, because `bun run`
    also runs any `pre<script>` and `post<script>` hooks. First the guard re-checks the digest. Its
    imports are `node:` built-ins and `src/content.ts`, which imports nothing. Then the pinned
    wrangler binary deploys.
  - `wrangler.jsonc` has no `main`, `build` or `alias`, and a unit test pins that. So wrangler runs
    no custom build and bundles no script.
  - The owner's approval binds the commit (env-exec refuses a dirty or unpushed tree), the config at
    that commit, and the artifact through its digest.
  - Residual, accepted: the keyed run trusts the host as it stands after the unkeyed build. Code that
    ran during that build (Vite, its plugins, the tests) runs as the same user. It could change
    anything that user can write, a fresh second install included, so a second install would not
    move the boundary. This is env-exec's trust model for every keyed run.
- **Build graph, stated plainly.** Workers Builds runs from the repository root. A root `bun install`
  installs the whole monorepo, Aztec packages included. Phase 1 proves
  `bun install --frozen-lockfile --filter @unleashed/landing`, which installs only the landing and
  its workspace dependency. If it works, the Workers Builds command uses it; if not, the full
  install's exposure is recorded as it is. Workers Builds also installs dependencies on its own
  before the build command, unless `SKIP_DEPENDENCY_INSTALL=1` is set. O1 sets it, and the first
  build's log must show only the filtered, frozen install.
- **CSP and headers** (`security-headers.ts`, emitted into `_headers` and served by `vite preview`):
  - The CSP: `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src
    'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none';
    require-trusted-types-for 'script'; trusted-types 'none'`.
  - Also `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, and
    `Cross-Origin-Opener-Policy: same-origin`.
  - Also `X-Frame-Options: DENY`, and a `Permissions-Policy` that denies powerful features and
    lists only feature names Chromium recognises. An unknown name logs a console error, which fails
    the smoke.
  - Also `Strict-Transport-Security: max-age=31536000`, without `includeSubDomains`, so the zone's
    other hosts keep their own policy.
  - Trusted Types forbids the DOM's HTML string sinks outright; the runtime uses `textContent` and
    canvas only. `base.css`'s `--ul-static` `data:` SVG stays unused, so `img-src 'self'` holds.
- **Zone features.** Web Analytics auto-injection, Rocket Loader, Zaraz, Bot Fight Mode's JS
  detections and Email Obfuscation would each change the HTML or add a request. The live integrity
  check catches each of them. The fix is a Configuration Rule scoped to the two hostnames where
  Cloudflare supports one (Rocket Loader, Email Obfuscation). Otherwise the owner weighs a zone-wide
  change against the two app hosts (Ask A6). Approving the landing does not approve that change.
  Before a zone-wide toggle, the lead records each affected host and its check: the testnet app
  answers 200 with its own CSP, and the mainnet app still answers with its Access login. After the
  toggle, the lead runs those checks, and on any failure the owner restores the setting. The CSP is
  never loosened.
- **NEL.** Every host in the zone sends `nel` and `report-to` headers that point at
  `a.nel.cloudflare.com` (live probe, `success_fraction: 0.0`). A browser posts there only after a
  failed load. That is the host's own telemetry, not the page's, but it is a request to another
  origin, so the Quality Bar names it (Ask A6).
- **Input validation.** No runtime input. Build-time content is repository data, and `esc()` escapes
  every text node and attribute anyway. A test pins every `href` to `LINKS`.
- **Supply chain.**
  - No new package: every dev dependency is in `bun.lock` at the versions tools uses (Vite 8.2.1,
    Vitest 4.1.10, TypeScript 6, Playwright 1.63.0, wrangler 4.129.1).
  - The 7-day release age and `--frozen-lockfile` apply in CI and in Workers Builds.
  - The shipped JavaScript is this workspace's code plus the design package's icon and mark data.
- **Frontend risks.**
  - XSS: static content, no sinks, Trusted Types.
  - Clickjacking: `frame-ancestors 'none'`.
  - CSRF: nothing to forge.
  - Reverse tabnabbing: no `target="_blank"`.
  - Prompt injection: no LLM flow.
- **The cutover.** The new page has no redirect surface. Nothing deletes or re-creates DNS records.
  The rule is disabled before it is deleted, so a rollback is one toggle.

## Assumptions

### Facts (verified)

1. Both hosts answer `302` to `https://testnet.app.unleashed.systems/`, for every path and query, on
   HTTP and HTTPS. `http://testnet.app.unleashed.systems/` answers 301 to HTTPS, so Always Use
   HTTPS is on and the redirect rule answers first. The zone's SOA `minttl` is 1800 (live probe).
2. The apex and `www` resolve to proxied Cloudflare addresses. Public DNS cannot tell a proxied A or
   AAAA record from a flattened CNAME, so the record type is unknown until O2 step 0.
3. Every host in the zone sends `report-to` and `nel` headers for `a.nel.cloudflare.com` (live probe).
4. `base.css` defines the dark tokens on `:root` and `[theme="dark"]`, and light on
   `[theme="light"]`, with no `prefers-color-scheme` rule. Its globals set `user-select: none` on
   `body` and hide scrollbars on `*`. It also defines `--ul-static` as a `data:` SVG (L211).
5. The board's tokens equal `base.css`'s for every token option C uses (compared value by value).
6. `ICONS` holds every icon C and the picked engines need (`arrow-right`, `external-link`, `check`,
   `eye-off`, `zap`, `warning-diamond`, `wallet`, `tv`). The package exports `./core/*` and
   `./base.css`.
7. Fonts: Next 48168 B, Mono 25800 B, Sixtyfour subset 4076 B, which is under Vite's 4096 B inline
   limit.
8. `typecheck:all` and `test:all` filter on `@unleashed/*`, and run on every PR.
9. `workspaces.test.ts` pins exactly three workspaces. `behavior-gating.test.ts` requires:
   - an aggregator that reads exactly the jobs in its `needs`;
   - positive-only filters whose prefixes exist on disk;
   - no job-level permissions outside `changes`.
10. The tools Workers use the repository root, `bun install --frozen-lockfile && bun run --cwd
    apps/tools build:<target>`, `BUN_VERSION=1.4.2` and `NODE_VERSION=24`. Their custom domains are
    attached in the dashboard for Production only.
11. Tools has no router. Bridge and Faucet are sections of one page (`useShell.ts`), so both rows link
    to the app's origin, as the board does.
12. Single Redirects run in `http_request_dynamic_redirect`, the first request phase. Workers are not
    in the phase list.
13. Cloudflare's Workers roles page offers per-Worker roles for API tokens. Editor deploys an existing
    Worker; creating one needs product-level Admin; Custom Domains do not support per-Worker roles yet.
14. `bun install` accepts `--filter` ("Install packages for the matching workspaces", Bun 1.4.2).
15. At 360 px the board's row grid leaves the Bridge name less room than its two tags need, so they
    overlap.
16. The concurrent stack `lifi-routing` edits these files that this plan may also touch:
    `AppShell.vue`, `ProgressBar.*` in the design package, `_build-tools.yml`, `_tools-e2e.yml`,
    `biome.json`, `README.md`, `AGENTS.md`, `apps/tools/README.md`, and the plan index, archive
    index, lessons and follow-ups. It touches neither `bun.lock` nor any `package.json`.

### Inferences (unverified; each has a check)

1. **A redirect rule runs before a Worker on a custom domain**, so attaching the domains changes
   nothing until the rule is off. Supported by Fact 12 and by the rule answering before Always Use
   HTTPS (Fact 1). Check: after attaching, both hosts still answer 302 (O2 step 1).
2. **The dashboard replaces an existing A or AAAA record** when it adds a custom domain. Cloudflare's
   launch post says so; the docs refuse an existing CNAME. Check: O2 step 1. Fallback: Workers
   routes. Never delete records.
3. **Vite bundles the workspace-linked design package into the config**, so `vite.config.ts` can
   import `src/markup.ts` (which imports `icons.ts`) under plain Node. Check: phase 1's build.
   Fallback: `vite build --configLoader runner`.
4. **The workspace passes the 7-day gate with already-locked versions.** Check:
   `bun install --frozen-lockfile` in phase 1; else a local, uncommitted exclude (lessons.md).
5. **`_headers` applies to the single-page fallback response.** Check: the live smoke requests
   `/nope` and asserts the CSP header.
6. **Workers Builds accepts a per-Worker Editor token, and wrangler finds the account with it.**
   Check: O1 and the first production build. Fallback: the existing account-wide token.
7. **`bun install --frozen-lockfile --filter @unleashed/landing` installs enough to build.** Check:
   phase 1, in a clean clone.
8. **The workers.dev host is `unleashed-landing.alejo-amiras.workers.dev`.** Check: K1's output.
9. **The token in `Keyed-Runs/Cloudflare-Workers` may have expired** (its template says "a TTL of
   hours"). The owner may mint a fresh one, same scope, before approving K1.
10. **COLRv1 rendering on iOS Safari** may differ from Chromium for the pixel wordmark. The tools app
    already ships this font, so the risk is not new. Check: the owner's iPhone look in O2 step 4.
11. **Workers Builds' output is byte-identical to a local build at the same commit** (same lockfile,
    Bun 1.4.2, Node 24; local is Node 24.21.0). Check: phase 6 step 9. If it is not, the live check
    compares the build id, the script and style URLs, and the set of `<script>` elements instead of
    every byte, and the change is logged.
12. ~~An unmatched non-navigation request gets a 404~~ **Refuted** by the post-implementation audit:
    with no Worker script, single-page mode serves `index.html` with a 200 for every unmatched
    request (Miniflare 4.129.1's asset worker, and the Cloudflare SPA routing page). The smoke server
    and its `/assets/nope.js` case now expect that. Check: the live smoke's `/assets/nope.js` case.

### Asks (the owner decides at the approval gate)

- **A1. Card engines.** Pick the placement and one engine per row from the card board. Recommended:
  Strip, B1 Portal, F1 Drip, N1 Tuner.
- **A2. Narrow phones.** Approve the tags dropping under the name below about 400 px (surface 9). If
  rejected, the 360 px overlap check is dropped and the page keeps the board's layout.
- **A3. Page details off the board.** Recommended:
  - Tab title "Unleashed · A lab for private apps on Aztec".
  - Description, used for search and link previews: "Unleashed is a lab for private apps on Aztec.
    Every experiment is a working app with its source in the open."
  - The app's mark as the favicon. No preview image for now; a drawn social card is a follow-up.
  - An unknown path shows the landing. `www` serves the same page, with the apex as canonical.
  - Text is selectable; scrollbars stay hidden as in the app.
  - Without JavaScript: dark only, no card screens, no Pause button (surface 13).
  - Wide screens keep the drawn left alignment (surface 14).
  - No pointer trace while paused or under reduced motion (surface 15).
  - The wordmark waits for its font, at most about 1.5 s (surface 16).
  - A failed engine leaves its row without a screen (surface 17).
- **A4. Tokens.**
  - For Workers Builds, the owner creates a new token with the per-Worker Editor role on
    `unleashed-landing` (O1). If Workers Builds refuses it, the existing build token is the fallback.
  - The keyed run uses the existing creation token. Its residual stays as `follow-ups.md` records
    it, and PR 2 updates that entry to say per-Worker roles now exist.
  - The keyed run trusts this host as it stands after the unkeyed build (Security, ledger D13).
  - Workers Builds gets `SKIP_DEPENDENCY_INSTALL=1`, so its own install is off (O1).
- **A5. Preview builds** (answered: yes). Each non-production branch is built and uploaded as a
  preview version on workers.dev, marked `noindex`.
- **A6. Zone features and NEL.**
  - If the live check finds an injected script or request, the owner turns that feature off. Use a
    hostname-scoped rule where one exists; a zone-wide change is the owner's call.
  - NEL stays on, and the Quality Bar names it, unless the owner wants to look for a zone setting
    that turns it off for all hosts.
- **FYI (no decision now).** The Bridge copy says "between Ethereum and Aztec". When `lifi-routing`
  ships more source chains, the copy is incomplete, not wrong. A follow-up records it.

## Phases

The fast gate runs after every meaningful step and at every phase end:
`bun run lint && bun run typecheck:all && bun run --cwd apps/landing test`.
Locally, browser commands run with `PLAYWRIGHT_BROWSERS_PATH=~/.cache/ms-playwright`.

### Phase 1: workspace and build pipeline ✓

Steps:
1. Create `apps/landing/package.json` (`@unleashed/landing`, `private`, `type: module`). Declare every
   import:
   - `@unleashed/design` (`workspace:*`);
   - dev dependencies at tools' locked versions: `vite`, `typescript`, `vitest`, `@types/node`,
     `@playwright/test` (`1.63.0`), `wrangler` (`4.129.1`).
2. Add the configs:
   - `tsconfig.json`: strict, `noEmit`, `allowImportingTsExtensions`, `vite/client` types;
   - `vitest.config.ts`: spread `sharedTest`, node environment, exclude `tests/browser/**`;
   - `tests/browser/tsconfig.json`.
3. Add `packages/design/src/core/mark.ts` with `MARK_INK` and `MARK_SIGNAL`.
4. Add `security-headers.ts`, and a Vite config:
   - woff2 never inlined;
   - one plugin (body stub for now, `_headers`, build id);
   - `modulePreload: { polyfill: false }`;
   - `preview.headers` from the same module;
   - a dev port from `LANDING_DEV_PORT`.
5. Add `wrangler.jsonc`:
   - name `unleashed-landing`, `compatibility_date` `2026-08-01`;
   - assets `./dist` with `single-page-application`;
   - `workers_dev: true`, `preview_urls: true`;
   - a header comment that lists the Workers Builds root directory, build and deploy commands;
   - a comment on why the custom domains are absent;
   - no `main`, `build` or `alias` (`wrangler-config.test.ts` pins this, since the keyed run deploys
     with this file).
6. Add `public/theme-boot.js`, `public/noscript.css`, and `public/favicon.svg` copied from tools.
7. Add `scripts/verify-build.ts` (the checks live in `scripts/dist-checks.ts`). It fails when any of
   these holds:
   - `dist/index.html` or `dist/_headers` is missing;
   - the `/*` CSP in `_headers` is not `default-src 'none'`, or has an `'unsafe-` source or an
     `http:` source;
   - the HTML has an inline `<script>` or a `style=` attribute;
   - an `@font-face` `src` holds a `data:` URL, or a woff2 file is missing from `dist/assets/`;
   - an absolute URL in the HTML is outside `LINKS` and the canonical apex;
   - the JavaScript exceeds 40 KB, or `dist/` exceeds 200 KB without the fonts;
   - the build-id meta is absent.
   On success it prints `DIST_SHA256=<hex>` over the sorted file list and contents. With
   `--expect <hex>`, it fails on a mismatch. It imports only `node:` built-ins and `src/content.ts`.
8. Add root scripts `dev:landing` and `build:landing`. Add `@unleashed/landing` to
   `scripts/ci-cd/workspaces.test.ts`.
9. Run `bun install`. Commit the lockfile change.
10. Export the committed tree, without a clone: `git archive HEAD | tar -x -C <scratch>/export`. In
    it, run `bun install --frozen-lockfile --filter @unleashed/landing && WORKERS_CI_COMMIT_SHA=<HEAD
    sha> bun run --cwd apps/landing build`. Log the result in `lessons/phase-1.md` (Inference 7).

Validation gate:
- Commands: `bun install --frozen-lockfile && bun run lint && bun run typecheck:all && bun run --cwd
  apps/landing test && bun run build:landing && bun run --cwd apps/landing verify:build && bun run
  test:ci-gating`.
- Pass:
  - every command exits 0;
  - `git diff --stat bun.lock` adds the workspace and no new package version;
  - `dist/assets/` holds the three woff2 files as files;
  - the result of step 10 is logged.
- Layers: install, lint, typecheck, unit, build, build guard, CI pins.

### Phase 2: the page as drawn, and the browser smoke ✓

Steps:
1. Write `src/content.ts` with the board's copy, word for word, and the three rows. Each row's
   `engine` stays `null` until phase 4.
2. Write `src/markup.ts`: `esc`, `icon` (from `ICONS`, 12 or 24 px), `mark`, the nav, the hero, the
   experiments, the caveat, and the footer (its Pause button rendered `hidden`).
3. Port option C's CSS to `src/styles/landing.css` on top of `base.css`. Make these adjustments:
   - map `.n` to `.ul-notch`, and drop the stage's outer notch;
   - make the page wrapper the `land` container, so the board's `cqi` and `@container` rules hold;
   - add `[hidden]{display:none!important}`, because `.btn{display:inline-flex}` beats the browser's
     own rule;
   - restore text selection;
   - add the narrow-phone tag rule (if A2 is approved);
   - add the font gate: `.js:not(.fonts-ready) .wm-hero{visibility:hidden}`, and `converge` only
     under `.fonts-ready`.
4. Write `index.html`'s static head per A3: title, description, canonical, `og:*` and `twitter:card`
   `summary`, theme boot, favicon, the `noscript` stylesheet.
5. Write unit tests:
   - `markup.test.ts`: escaping; the open slot is a `div`; tags map to the right class and icon;
     every `href` is in `LINKS`.
   - `content.test.ts`: every link is `https:` and in `LINKS`; names are unique.
   - `mark.test.ts`: `MARK_INK` equals `AppShell.vue`'s string.
   - `favicon.test.ts`: the favicon is byte-identical to tools'.
   - `security-headers.test.ts`: the CSP has no `'unsafe-*'` and no `http:` source.
6. Write `tests/browser/global-setup.ts`, the static server described under Trade-offs: `dist/` on
   `127.0.0.1:0`, the emitted `_headers` subset, and the fallback rules. It closes in teardown. With
   `LANDING_URL` set, it starts no server. A unit test covers its `_headers` parser: overlapping rules
   combine, and unknown syntax throws.
7. Write `tests/browser/smoke.spec.ts`. Expected rows and links come from `content.ts`, never from
   hard-coded counts. The cases:
   - **render**: the heading and every row; each link's target equals the content;
   - **layout**: at 320, 360, 390, 1440 and 1920 px, no horizontal scroll, and no tag overlaps a
     name (if A2 is approved). 320 px is a 1280 px window at 400% zoom, the reflow case;
   - **keyboard**: Tab reaches every link, then the Pause button, in DOM order, and each shows a
     focus outline;
   - **security**: listeners attach before navigation; zero `securitypolicyviolation` events, zero
     requests to another origin, zero console errors;
   - **themes**: with `colorScheme` light and dark, `<html theme>` and the body background match the
     tokens;
   - **no JavaScript**: all text and links render; the Pause button and the card screens are hidden;
   - **fonts fail**: with font requests aborted, the text still renders, and the wordmark appears
     within 2 s;
   - **fallbacks, in both modes**: a navigation to `/nope` gets the landing with status 200 and the
     CSP; a fetch of `/assets/nope.js` gets the landing too, with the page headers and no long cache.
     Live mode therefore checks the local server's rules against the Worker;
   - **live mode only**:
     - the response headers contain every header in `security-headers.ts`, with these values; extra
       headers from Cloudflare are allowed;
     - hashed files carry `immutable`, and `/` does not;
     - the build id matches the reference build, then the decoded body of `/` is byte-identical to
       that build's `dist/index.html`;
     - no request goes to `/cdn-cgi/`.
8. Take full-page screenshots at 1140 px in both themes with reduced motion. Compare them by eye
   with `design/s-c-dark.png` and `s-c-light.png`. Log the comparison in `lessons/phase-2.md`.
9. Run the same smoke once in WebKit at 390 px (local only).

Validation gate:
- Commands: the fast gate, then `bun run build:landing && bun run --cwd apps/landing verify:build &&
  bun run --cwd apps/landing test:browser`, then the WebKit run.
- Pass:
  - all exit 0;
  - the smoke reports zero CSP violations and zero off-origin requests;
  - the side-by-side shows no layout difference from the board, except the listed adjustments.
- Layers: lint, typecheck, unit, build, build guard, browser smoke (Chromium and WebKit).

### Phase 3: motion ✓

Steps:
1. Write `motion.ts` (`Ticker`, `playing`, `shouldRun`) and its unit tests:
   - a 250 ms clamp;
   - at most one step per frame;
   - debt never above one tick;
   - `playing` starts false under reduced motion;
   - a manual Pause survives a media-query change;
   - Play overrides reduced motion;
   - `shouldRun` is false when hidden, off screen or paused.
2. Write `engines/engine.ts` and `engines/loop.ts`. The engine reads the palette from the tokens and
   watches its canvas with ResizeObserver and IntersectionObserver. The loop stops requesting frames
   when no engine can run.
3. Write `engines/dither-field.ts` (Bayer matrix, field value, cell colour) and its unit tests:
   - the Bayer matrix is a permutation of 0 to 15;
   - the field is deterministic for a given step;
   - the band reaches signal at the right edge;
   - heat decays to 0.
4. Write `engines/dither.ts`: a cols×rows canvas whose CSS size is exactly `cols·4 × rows·4` px,
   `image-rendering: pixelated`, the pointer trace while playing (touch ignored), and a redraw on
   theme change.
5. Wire `main.ts`: the font gate, the Pause button ("Pause motion" and "Play motion"), the media
   queries, `visibilitychange`.
6. Expose `data-state="running|paused|still"` on each canvas for the smoke.
7. Extend the smoke:
   - the dither canvas has foreground pixels;
   - two samples 400 ms apart differ while running;
   - two samples are equal under reduced motion and after Pause; Play resumes;
   - with `document.hidden` emulated and `visibilitychange` dispatched, `data-state` leaves
     `running`;
   - while paused, `requestAnimationFrame` (counted by an init script) is called at most once in a
     second;
   - at 390 px and device scale factor 1.5, sampled cells are each 6 device pixels wide;
   - with `getContext` stubbed to return null (an init script), every screen is hidden, the links
     and Pause still work, and no uncaught error is thrown.
8. Measure, locally, 100 consecutive steps of every visible engine at 1440×1500 in Chromium, and log
   the median and the 95th percentile in `lessons/phase-3.md`. The target is a median under 4 ms.

Validation gate:
- Commands: the fast gate, then the build, the guard and `test:browser`.
- Pass:
  - all exit 0;
  - the local measurement is logged with a median under 4 ms;
  - reduced motion and Pause both leave a drawn, unchanging canvas.
- Layers: lint, typecheck, unit, build, build guard, browser smoke.

### Phase 4: the card engines the owner picked ✓

Warning: write no code in this phase before the owner's pick is quoted in this file.

Steps:
1. Quote the owner's pick (A1) here. Set each row's `engine` in `content.ts`.
2. For each picked engine, write `engines/<name>.ts` as a pure model (state and `step`) plus a draw
   function:
   - port it from `design/cards.src.html`;
   - take glyphs from `ICONS` (`wallet`, `tv`), not pasted paths;
   - split it to stay within cognitive complexity 15 and 80 lines per function.
3. Render the screen element in `markup.ts` only for rows with an engine, `aria-hidden`, inside the
   row's link. Add the placement CSS, and hide `.screen` in `noscript.css`.
4. Unit-test each model's state machine. Examples:
   - Portal: an amount crosses the bar, veils, and lands on the Aztec lane.
   - Drip: a drop becomes a coin, and a coin at the wallet lights it.
   - Tuner: the scan line wraps, and a hold stops it for its count.
5. Extend the smoke:
   - each screen has foreground pixels;
   - each screen stops under Pause and under reduced motion;
   - a screen scrolled out of view leaves `running`;
   - a row still inverts on hover with its screen intact.

Validation gate:
- Commands: the fast gate, then the build, the guard and `test:browser`, then the WebKit run.
- Pass:
  - all exit 0;
  - the screenshots at 390 and 1440 px in both themes match the card board's picked set.
- Layers: lint, typecheck, unit, build, build guard, browser smoke.

### Phase 5: CI ✓

Steps:
1. Add `.github/workflows/_build-landing.yml`:
   - `workflow_call` with input `ref`; `contents: read`; a 15-minute timeout;
   - steps: checkout, setup-bun, build (its guard runs inside), setup-playwright, `test:browser`;
   - the Playwright report is uploaded on failure.
2. In `pr-quick.yml`:
   - add a `landing` filter: `apps/landing/**`, `packages/design/src/**`,
     `packages/design/package.json`, `.github/workflows/_build-landing.yml` (`workflows` already
     covers the actions);
   - add the `needs-landing-build` output, true on dispatch, `landing`, `workflows` or `root-config`;
   - add a `build-landing` job;
   - add the job to `quality-status`'s `needs`, its env and its `expect` case (success when the flag
     is true, skipped when false, an error otherwise). Keep the name `quality-status`.
3. In `behavior-gating.test.ts`: add `landing` to `APPS`, call `assertGraphCovered` on the landing
   filter, and pin `_build-landing.yml`, the `needs-landing-build` wiring, and the landing's
   Playwright pin equal to the tools app's.

Validation gate:
- Commands: `bun run lint:actions && bun run test:ci-gating`, then the fast gate.
- Pass: all exit 0. No required check is renamed or added.
- Layers: actions lint, CI pins, lint, typecheck, unit.

After phase 5: run the Post-implementation loop (steps 2 and 3) over the whole PR 1 diff.

### Phase 6: create the Worker, connect Workers Builds, merge PR 1

Steps:
1. Run the repository's PR gates: `bun run audit:tools && bun run test:all`.
2. Commit, and push `worktree-landing`. The tree must be clean, and HEAD must equal the remote tip.
3. Build and guard unkeyed: `bun install --frozen-lockfile && bun run --cwd apps/landing build &&
   bun run --cwd apps/landing verify:build --channel production`. Note the printed `DIST_SHA256`.
4. File the keyed run (runbook K1) with that digest. Hand the owner the `op-remote alejo-box <id>`
   line, and watch it with `env-exec wait <id>`. The worktree's `dist/` is the reference build for the
   pre-merge live checks.
5. Run the live smoke against `https://unleashed-landing.alejo-amiras.workers.dev`.
6. Hand the owner runbook O1 (token and Workers Builds), and wait for "builds connected".
7. Open PR 1 (Delivery). Attach the screenshots, quote the sign-offs, and watch `gh pr checks`.
8. When every required check is green, squash-merge PR 1.
9. Wait for the Workers Builds production deploy of `main`. Check its build log: only the filtered,
   frozen install ran. Build the reference for the merge commit unkeyed, in an export:
   `git archive <merge-sha> | tar -x -C <scratch>/main-<sha8>`, then the filtered install and
   `WORKERS_CI_COMMIT_SHA=<merge-sha> bun run --cwd apps/landing build` there. Run the live smoke from
   that export, so its reference `dist/` is the merge commit's (Inference 11).

Validation gate:
- Commands:
  - `bun run audit:tools && bun run test:all` exit 0;
  - `env-exec wait <id>` exits 0;
  - `LANDING_URL=https://unleashed-landing.alejo-amiras.workers.dev bun run --cwd apps/landing
    test:browser` exits 0 before the merge (from the worktree) and after it (from the merge export);
  - `gh pr checks <PR1>` is all green before the merge.
- Pass: the live build id equals the merge commit's first 8 characters, and the live smoke passes,
  integrity check included.
- Layers: repository gates, live e2e (the smoke against production), CI.

### Phase 7: cutover and live verification

Steps:
1. Hand the owner runbook O2, one checkpoint at a time.
2. After each checkpoint, check both hosts with `curl -sSI` over HTTPS and HTTP.
3. After the rule is off, poll until both hosts serve the landing's build id, at most 5 minutes.
   Then verify in Chromium against both hosts:
   - both themes, at 390 and 1440 px;
   - reduced motion, and Pause and Play;
   - every link's target answers 200;
   - the headers, the integrity check, and the build id.
4. Run the WebKit pass at 390 px against the apex.
5. Save the screenshots for PR 2, and tell the owner "verified" or "roll back".
6. After the owner deletes the rule, run the smoke once more on both hosts.

Validation gate:
- Commands:
  - `LANDING_URL=https://unleashed.systems bun run --cwd apps/landing test:browser` exits 0 from the
    merge export, and the same with `https://www.unleashed.systems`;
  - `curl -sSI https://unleashed.systems/` shows 200 and the CSP;
  - `curl -sSI http://unleashed.systems/` shows a 301 to `https://unleashed.systems/`.
- Pass:
  - both hosts serve the landing with zero CSP violations, zero off-origin requests, and HTML
    identical to the build;
  - no 302 remains;
  - the owner confirms the iPhone look and the deleted rule.
- Layers: live e2e on the production hosts.

### Phase 8: docs and close-out (PR 2)

Steps:
1. Cut `landing-close-out` from `origin/main`.
2. Reconcile against trunk first: `lifi-routing` edits these same files.
3. Update `README.md`: the table row, and § Hosting (three Workers, the apex and `www`).
4. Update `AGENTS.md`: the read-before list, § Hosting, and the CI summary.
5. Note the second consumer of `base.css` in `packages/design/README.md`. Leave `apps/tools/README.md`
   alone: an edit there re-runs the tools build and its e2e shards.
6. Add the follow-ups. Then write the Outcome, promote the lessons, move the archive, and move the
   index line (Post-implementation step 5).

Validation gate:
- Commands: `bun run lint && bun run test:ci-gating` (`doc-links.test.ts` resolves every link), and
  `bash scripts/check-no-local-paths.sh`.
- Pass: all exit 0. The docs describe only the live state.
- Layers: lint, CI pins.

## Cloudflare runbooks

### K1: keyed run that deploys the Worker (lead files, owner approves)

- Template: `apps/tools/cloudflare.env.example`, with one secret, `CLOUDFLARE_API_TOKEN`. Its header
  gives the scope.
- Warning: if the 1Password item's token has expired, mint a fresh one before approving. Use the same
  scope and a TTL of hours, IP-filtered to `alejo-box`.
- Request, from the worktree at the pushed HEAD, after phase 6 step 3:
  `env-exec request --template apps/tools/cloudflare.env.example --slug landing-worker -- bash -c 'bun apps/landing/scripts/verify-build.ts --expect <DIST_SHA256> --channel production && apps/landing/node_modules/.bin/wrangler deploy -c apps/landing/wrangler.jsonc'`
- Both entry points run directly, so no `package.json` script or hook runs beside the token.
- Owner: `op-remote alejo-box <id>`. It shows the commit, the command with the digest, and the
  secret's reference. On `y` it runs.
- What it does:
  1. It re-checks that `dist/` is the reviewed build.
  2. It runs `wrangler deploy -c wrangler.jsonc`, which creates `unleashed-landing` with only its
     `workers.dev` host.
  - No install, no build, no domain, route or DNS change.

### O1: token and Workers Builds (owner, dashboard)

1. **Token.** Open My Profile › API Tokens › Create Token › Custom token.
   - Name: `workers-builds-unleashed-landing`.
   - Permissions: Workers, the **Editor** role, on the Worker `unleashed-landing` only.
   - Account: this one. No zone permission, no TTL.
   - Create it, and do not copy the value anywhere. Workers Builds stores it.
2. **Connect.** Open Workers & Pages › `unleashed-landing` › Settings › Build › Connect.
   - Repository: the GitHub connection the other two Workers use, and `alejoamiras/unleashed`.
   - Production branch: `main`. Root directory: the repository root (empty).
3. **Commands.**
   - Build: `bun install --frozen-lockfile --filter @unleashed/landing && bun run --cwd apps/landing
     build` (or without `--filter`, if phase 1 says the filter fails).
   - Deploy: `bun run --cwd apps/landing worker:deploy`.
   - Builds for non-production branches: on, with the same build command and the non-production
     deploy command `bun run --cwd apps/landing worker:preview`.
4. **Variables.** `BUN_VERSION` = `1.4.2`, `NODE_VERSION` = `24`, `SKIP_DEPENDENCY_INSTALL` = `1`.
   The last one stops Workers Builds' own install, so only the build command's install runs.
5. **API token.**
   - Warning: do not let the dialog create a token; that one adds KV, R2 and Workers Routes on every
     zone.
   - Select `workers-builds-unleashed-landing`.
   - If the dialog does not list it or refuses it, stop and tell the lead. The fallback is the token
     the other two Workers use, with its known residual.
6. **Check.** Settings › Build shows the repository, `main`, both commands, both variables and the
   token. A build of `main` may start and fail, because `main` has no `apps/landing` yet. That is
   expected and changes nothing live.
7. Tell the lead "builds connected", and name the token you selected.

### O2: cutover (owner, dashboard; after the lead says the main build is verified)

0. **Record.** Send the lead:
   - the redirect rule: its name, its match expression, the target URL, the status code, the
     "preserve query string" setting, and its place in the rule order;
   - DNS › Records for `unleashed.systems` and `www`: the type, the content and the proxy status of
     each record.
   The lead stores them in `lessons/phase-7.md` for a rollback.
1. **Apex.** Open `unleashed-landing` › Settings › Domains & Routes › Add › Custom domain, and enter
   `unleashed.systems`.
   - If the dashboard offers to replace the existing DNS record, accept. Leave previews off, as on
     `testnet.app.unleashed.systems`.
   - Check: the domain shows as active. Tell the lead "apex attached". The lead checks that both
     hosts still answer 302.
   - Warning: never delete a DNS record. If the dashboard refuses, stop and tell the lead. Then add
     the Workers route `unleashed.systems/*` on the same Worker instead. A route keeps the existing
     record. Each host gets one mode, a custom domain or a route, never both.
2. **`www`.** Same as step 1 with `www.unleashed.systems` (route: `www.unleashed.systems/*`). Tell the
   lead "www attached", and which mode each host got.
3. **Switch.** First check both hosts are ready: each custom domain shows its certificate as active
   (a route uses the zone's existing certificate). Then turn the redirect rule off. Do not delete it.
   Tell the lead "rule off". The lead polls until both hosts serve the landing.
4. **Look.** The lead runs phase 7 and asks you to open `https://unleashed.systems` on your iPhone.
   Tell the lead what you see. The lead answers "verified" or "roll back".
5. **Finish.** On "verified", delete the redirect rule. Tell the lead "rule deleted".

### R: rollback

- **Before step 5**: turn the redirect rule back on. Redirect rules run before the Worker, so both
  hosts answer 302 to the app again; the lead polls to confirm. The domains or routes can stay
  attached.
- **After step 5**: re-create the rule from the step 0 record, then turn it on.
- **A code fault after the cutover**: until a landing version has passed the live checks on both
  hosts, the rollback is the redirect rule (re-enabled, or re-created from the step 0 record), because
  the previous version may hold the same fault. After that, roll back in the dashboard, under
  `unleashed-landing` › Deployments, to the last version that passed. Then fix forward through a PR.
  A revert PR waits on the full CI.

## Delivery

Two sequential PRs, not a stack. PR 1 must merge before the cutover, because Workers Builds deploys
`main`. PR 2 can only be written once the cutover is live, because the docs describe live state.

| Arc | Phases | Branch | Stacks on | `/code-review` |
|---|---|---|---|---|
| 1. Landing app, Worker config, CI | 1-6 | `worktree-landing` | `main` | off |
| 2. Docs and close-out | 8 (after 7) | `landing-close-out`, cut from `origin/main` after PR 1 merges | `main` | off |

- PR 1 title: `feat(landing): ship the dither tide landing for unleashed.systems` (65 characters).
- PR 2 title: `docs: unleashed.systems serves the landing; close the landing plan` (66 characters).
- The Codex fix loop runs over PR 1's diff after phase 5, before the keyed run, so the code deployed by
  hand is the reviewed code. PR 2 is docs only, and Codex reviews it once for drift from the live
  state.
- Plain `gh pr create` for each. The lead merges each with `gh pr merge --squash` once every required
  check is green. Never `--admin`.
- PR 1 carries `bun.lock`, so it also runs the tools e2e shards and the contract suites. That is
  expected, and they must pass like any other required check.

## Competing outline (cheapest first)

The alternative drafted against this plan, sent to both audits:

- **Hand-authored page.** `index.html` holds the board's expanded markup, with icons and the mark
  pasted in. `public/_headers` is a static file. One `main.ts` ports the board's engine classes
  almost verbatim.
- **No build-time code.** The Vite config only stops font inlining.
- **The smoke runs under `wrangler dev`**, which reads the static `_headers`.
- **For it**: about half the code; the page source reads like the board; no config-time TypeScript
  import (Inference 3 goes away).
- **Against it**:
  - icon and mark data are copied a third time;
  - a new experiment is an edit in three places (markup, engine registry, copy);
  - `wrangler dev` starts workerd, which needs its own port and an inspector port per run on a shared
    host;
  - the board's single-file engines exceed the complexity budgets and must be split anyway.

Both audits kept build-time rendering. Both asked to trim its machinery, and this revision does.

## Audit record

### Round 1, Codex (`gpt-6.1-sol`, high; session 01a12248-e1b5-7c82-886a-bda60c84fe87)

Verdict: `conditional approve (with conditions: correct credential scoping, remove the DNS-deletion
fallback, and repair the build and browser gates)`.

| # | Finding | Disposition |
|---|---|---|
| C1 High | Per-Worker token roles exist; the "cannot be scoped" claim is stale | Adopted after checking Cloudflare's roles page: per-Worker Editor token for Workers Builds (O1, A4); the follow-up entry is updated in PR 2 |
| C2 High | The keyed run installs and builds with the token present | Adopted: the keyed command re-checks a dist digest and deploys only (K1) |
| C3 High | Deleting DNS breaks the rollback; "about a minute" is not a gate | Adopted: no record is ever deleted, routes are the fallback, the DNS state is recorded, the lead polls |
| C4 High | The `url(data:` guard contradicts `base.css`'s `--ul-static` | Adopted: the guard checks `@font-face` sources only |
| C5 Medium | Zone-wide changes exceed scope; same-origin injection passes the CSP | Adopted: hostname-scoped rules first (A6), and the byte-identical HTML check |
| C6 Medium | Preloading does not guarantee the converge animation runs on the real font | Adopted: the font gate, bounded at 1.5 s (surface 16) |
| C7 Medium | Not crisp at any DPR; one timed draw proves little | Adopted: exact CSS cell size, the claim restated, a DSF 1.5 cell check, a 100-step measurement, the rAF idle check |
| C8 Medium | The smoke misses keyboard, no-JS, failed fonts, hidden tab, phone WebKit | Adopted: all added; WebKit in local and live gates, not in CI (ledger D7) |
| C9 Medium | Fallbacks are implicit; a media-query change undoes Pause | Adopted: surfaces 13-16, and a manual Pause wins |
| C10 Medium | "One entry adds experiment 3" overpromises | Adopted: the Quality Bar is restated, and rows derive from content |
| C11 Medium | AGENTS.md's PR gates are missing; port handling is race-prone | Adopted: `audit:tools` and `test:all` in phase 6; an in-process server on port 0 |
| C12 Low | Three plugins where one does; wrong fallback flag | Adopted: one plugin; `--configLoader runner` |

### Round 1, Opus 5.5 (fable role)

Verdict: `conditional approve (with conditions: size the dither canvas to exact 4 px cells and restate
the DPR claim; add a [hidden] rule and a no-JS smoke; keep install-time code out of the keyed process
and correct the build-graph claim; make the live injection check compare the served HTML byte for byte
and raise the zone's NEL reporting with the owner; list the undrawn surfaces for sign-off; record the
DNS records before the cutover and prefer routes if the dialog refuses)`.

| # | Finding | Disposition |
|---|---|---|
| F1 Medium | Cells not square at common widths | Adopted (with C7) |
| F2 Medium | The `hidden` Pause button shows without JS | Adopted: `[hidden]` rule and the no-JS case |
| F3 Medium | Install code beside the token; the "smaller graph" claim is false | Adopted: K1 deploys only; the claim is corrected; the `--filter` install is tried in phase 1. The optional "import repository" flow is rejected: the owner picked a keyed deploy, and it would put the first deploy on `main` unverified |
| F4 Medium | NEL to `a.nel.cloudflare.com`; the injection check has a hole | Adopted: verified by a live probe; the Quality Bar names NEL (A6); byte-identical HTML and no `/cdn-cgi/` |
| F5 Medium | Undrawn surfaces: wide screens, no-JS theme, trace while paused, Bridge copy drift | Adopted: surfaces 13-15, A3, a 1920 px width, the FYI |
| F6 Medium | DNS state unrecorded; fallback order backwards; HTTP check | Adopted: O2 step 0, routes first, the 301 check |
| F7 Low | `/assets/*` immutable plus the fallback caches HTML | Adopted: one cache rule per emitted file |
| F8 Low | Canvas text may draw in the fallback font | Adopted: `document.fonts.load` before card layout |
| F9 Low | The data-URL guard is broken or ineffective | Adopted (with C4) |
| F10 Low | A2-dependent check, Permissions-Policy names, local 4 ms, tools README edit, Fact 16 incomplete | Adopted: each fixed; the tools README is not edited |
| F11 Low | Simplify: circular check, static head, `ICONS`, idle rAF, dashboard rollback | Adopted: each fixed |

### Final pass, Codex (`gpt-6.1-sol`, high, fresh session 01a1225c-cd71-70b3-845d-e0725f9797c8)

Verdict: `conditional approve (with conditions: tighten K1's executable trust boundary, disable
Workers Builds' automatic install, repair post-merge integrity verification, and complete the
remaining validation gaps)`. It ruled D7 acceptable: WebKit in the local and live gates and the
owner's iPhone, recorded as release gates; the Chromium CI check claims no cross-browser coverage.

| # | Finding | Disposition |
|---|---|---|
| X1 High | The digest binds the artifact, not the code that deploys it; `bun run` runs `pre`/`post` hooks; wrangler could run a custom build | Adopted in part. Checked: Bun 1.4.2 runs a `pre<script>` hook. K1 now calls the guard and wrangler's binary directly. The guard's imports are limited, `wrangler.jsonc` has no `main`, `build` or `alias` (pinned by a test), and the approval binds commit, config and digest. Rejected: deploy tooling from a second, independent install. Code from the unkeyed build runs as the same user and could alter a second install too, so it moves no boundary. The residual is written down under Security (ledger D13) |
| X2 Medium | Workers Builds installs on its own unless `SKIP_DEPENDENCY_INSTALL` is set | Adopted after checking Cloudflare's build-image page: O1 sets it, and phase 6 checks the build log |
| X3 Medium | Build id format unspecified; post-merge check has no reference build at the merge commit; byte compare should use decoded bodies | Adopted: the first 8 hex characters everywhere; a reference build from a `git archive` export of the merge commit (no clone); decoded body after a build-id match; headers checked as "contains"; Inference 11 covers a non-reproducible build |
| X4 Medium | A zone-wide toggle must not silently change the excluded apps | Adopted: record and re-check the app hosts, restore on failure; landing approval does not approve that toggle |
| X5 Medium | No zoom or reflow case; unbounded card font waits; no fallback for a failed engine | Adopted: a 320 px reflow width; every font wait bounded and caught; per-engine `try`, a null-context smoke; surface 17 for sign-off |
| X6 Medium | The local server claims Worker equivalence without proof | Adopted: emitted subset only, unknown syntax throws, a parser unit test, and both fallback answers checked live |
| X7 Low | Mixed attach modes; HTTPS readiness; rollback to a version that may hold the fault | Adopted: one mode per host, certificates active before the switch, the rule stays the rollback until a version passes live |
| X8 Low | The competing-outline trade-off misstated its header handling | Adopted: reworded |

## Decision ledger

| # | Decision | Chosen | Rejected, and why | Source |
|---|---|---|---|---|
| D1 | Framework | Vanilla TypeScript and Vite, build-time HTML | Vue runtime (30 KB for static text); build-time Vue render (no matching design components); hand-written HTML (pasted paths, three-place edits) | lead; both audits kept it |
| D2 | `www` | Serve both hosts, with the apex canonical | A 301 needs a dashboard rule or a Worker script | lead |
| D3 | Domains | Custom domains, routes as the fallback | Deleting records (negative DNS caching breaks a rollback) | lead, C3, F6 |
| D4 | Build token | A per-Worker Editor token; the existing token as the fallback | The account-wide token by default (C1 showed a narrower one now exists) | C1 |
| D5 | Keyed run | Deploy only, pinned by a dist digest | Install and build inside the keyed run; Workers Builds' import flow (overrides the owner's pick, and the first deploy would go out unverified) | C2, F3 |
| D6 | Smoke server | An in-process `node:http` server on port 0, applying `dist/_headers` | `vite preview` on a probed port (a race); `wrangler dev` (workerd and its inspector port on a shared host) | lead, C11 |
| D7 | WebKit | Local and live gates, plus the owner's iPhone, each recorded as a release gate | In CI (a longer required check; Linux WebKit is not iOS Safari anyway) | lead, after C8; upheld by the final pass |
| D8 | Unknown paths | The landing (single-page fallback) | A 404 page (undrawn); Cloudflare's bare 404 | lead; A3 |
| D9 | Previews | Non-production branches upload preview versions, marked `noindex`, with no alias of the page's own | No previews (the owner chose previews); tools' hashed alias (nothing here trusts its host) | owner, A5 |
| D10 | Delivery | Two sequential PRs | One PR (the docs would claim a state that is not yet live); a stack (PR 2 cannot be written before the cutover) | brief, lead |
| D11 | Font gate | Hide the wordmark until its font loads, at most 1.5 s | The board's immediate animation (it would run on the fallback face) | C6 |
| D12 | setup-playwright | Unchanged | A workspace input (CI's install already has the same Playwright pin) | F10 |
| D13 | Keyed run's tooling | The worktree's pinned wrangler, called directly, with the residual recorded | A second install for the deploy tools (code from the unkeyed build runs as the same user and could alter it as well) | X1 |
| D14 | Reference builds | `git archive` exports in the scratch directory | A temporary clone (the brief allows no clones); checking out `main` in the worktree (moves the branch's working state) | X3, the brief |

Unresolved: none. One residual is accepted and goes to the owner under A4: the keyed run trusts the
host after the unkeyed build (D13).

## Post-implementation

Run this after phase 5, over the whole PR 1 diff from the plan baseline (`origin/main` at 9725c08).
`code_review` is `off`, so there is no `/code-review` step.

1. **(Absent: `code_review: off`.)**
2. **Codex audit.** Use `/codex`: `~/.claude/skills/codex/scripts/run-codex.sh <prompt> <worktree>
   high read-only gpt-6.1-sol`. The prompt carries:
   - the diff from `9725c08`, this plan and the decision ledger;
   - the adversarial ask: what could go wrong; what an attacker targets (CSP gaps, injected scripts,
     the tokens, link tampering); what we trust that we should not;
   - these two rules, verbatim:
     - "Report bugs and small, targeted improvements only. Do not propose speculative abstractions,
       extra configuration surface, new layers, or rewrites — the smallest change that fixes each
       real problem. If code works and is clear, leave it alone."
     - "Audit the comments for value per character. Flag any comment that narrates what the code
       visibly does, restates its line, references implementation plans / phases / reviews, or
       spends a paragraph where a sentence works — and flag places where a non-obvious invariant or
       constraint deserves a comment it doesn't have. Comments are permanent context every future
       reader, human or LLM, pays to re-read: they must be few, dense, and exact."
3. **Fix loop.**
   - Verify each finding against the code first.
   - Apply the accepted fixes and commit them.
   - Log the round in `lessons/phase-5.md`: each finding, adopted or rejected, and why.
   - Resume the same session (`resume-codex.sh <session> <followup> <codex-dir> high`) with the fix
     diff and the same two rules.
   - Stop when a round yields no new material finding.
   - Warning: still material after 3 rounds means stop and surface it to the main session.
4. **Delivery.** Run phase 6, then phase 7. Open PR 1 only after step 3 converges.
5. **Close-out (PR 2's final commits).**
   1. Write `## Outcome` directly after the front matter. It holds:
      - the final status, and what shipped with PR numbers;
      - a disposition line for each dropped or rejected item;
      - an `Open items:` line naming the `follow-ups.md` entries, or `none`;
      - a line retiring this plan's `/goal` and `/loop` seeds.
      Plans carry no calendar dates (AGENTS.md).
   2. Promote the generalizable gotchas into `implementations-plan/lessons.md`, one line each, with a
      link into the archive. Deduplicate, retire what they supersede, and keep the file under about
      8 KiB.
   3. File open work as entries in `implementations-plan/follow-ups.md` (this repository's rule).
      Known entries:
      - move `AppShell.vue` onto `core/mark.ts` and delete the pin test;
      - a drawn social preview image;
      - per-Worker tokens for the two tools Workers;
      - the Bridge copy once more source chains ship;
      - the Cloudflare-account entry, updated: per-Worker roles now exist.
   4. Archive the plan in its own commit: `git mv implementations-plan/landing
      implementations-plan/archive/landing`. Repair the links that the extra level breaks
      (`git grep -n 'landing/'`).
   5. Move the index line from `implementations-plan/index.md` into `archive/index.md`, marked
      archived.

   | Situation | Home |
   |---|---|
   | Work inside this implementation | this `plan.md` and the PR |
   | Actionable work that outlives the plan | an entry in `implementations-plan/follow-ups.md` (this repository's rule, in place of issues) |
   | A suspected exploitable weakness | a private draft security advisory; `plan.md` records only "tracked privately: GHSA-…" |
   | Rejected, superseded or already done | a disposition line in the Outcome block |
   | Knowledge that prevents a repeat | `implementations-plan/lessons.md` (8 KiB budget) |

6. **Teardown after PR 2 merges.** When `git fetch -q origin main && git cat-file -e
   FETCH_HEAD:implementations-plan/archive/landing/plan.md` succeeds, run `agent-worktree done landing
   --merged`.
   - This session did not enter through `EnterWorktree`, so there is nothing to exit.
   - On a refusal, relay its output and stop; never force.
   - The lead merges PR 2 itself, so it runs this in the same turn as the merge.

## Seeds (draft; final after approval)

ELI5: https://claude.ai/artifact/2Mj8rV7osT9DDgoxEYo9yP (private to the owner). Source:
`implementations-plan/landing/eli5.html` (gitignored; fonts and mark filled in at publish).

Recommended: `/goal`, because each gate's evidence lands in the transcript. The owner's keyed-run and
dashboard steps pause it.

```
/goal Every phase in implementations-plan/landing/plan.md is marked ✓, each backed by its validation gate reported passing in the transcript, with LESSONS_FILE=implementations-plan/landing/lessons/phase-N.md printed for each phase; /code-review was NOT run (code_review: off); the Codex fix loop on PR 1's diff converged, shown by a resumed gpt-6.1-sol pass at high quoted with no new material findings; PR 1 and PR 2 exist on GitHub, opened only after the loop converged, both squash-merged with every required check green; https://unleashed.systems and https://www.unleashed.systems pass the live smoke (LANDING_URL=… bun run --cwd apps/landing test:browser exit 0) and no longer 302; the archive-move commit's git show --stat is in the transcript; bun run lint and bun run test:all both exit 0.
```

Alternative: `/loop`.

```
/loop 15m Drive implementations-plan/landing forward. Never idle. Each firing: (1) read plan.md and lessons/ (authoritative), judged against its Outcome & Quality Bar; if plan.md is gone, check `git fetch -q origin main && git cat-file -e FETCH_HEAD:implementations-plan/archive/landing/plan.md`: if it succeeds, run `agent-worktree done landing --merged`, report, clear this loop and stop; if a PR is open, `gh pr view --json statusCheckRollup`. (2) Waiting on CI or on the owner (K1, O1, O2) is fine: prepare the next step, never cross a gate. (3) No task in hand: take the next pending step, run the fast gate after each edit, commit with `env -u SSH_AUTH_SOCK git commit`, push. (4) Stuck: consult /codex at high on gpt-6.1-sol, log it in lessons, act; never cross a hard limit (no merge without green required checks, no --admin, no Cloudflare or DNS action, no secret). (5) Same step failed 5 times: reassess with Codex. (6) Phase gate green: paste it, mark ✓, write lessons, print LESSONS_FILE=…; after phase 5 run the Post-implementation loop before phase 6. (7) All phases ✓: close out per Post-implementation, merge PR 2 when green, tear down.
```

Use exactly one of the two per session.
