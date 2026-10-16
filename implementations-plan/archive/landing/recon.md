# Recon: landing

Read against `origin/main` at 9725c08, the worktree's base. One read-only explorer swept the repository
for reuse; the lead added the live host probes, the Cloudflare documentation checks and the overlap
with the concurrent `lifi-routing` stack.

## Reuse map

| Capability | Existing code | Verdict | Note |
|---|---|---|---|
| Tokens, notch, motion timings, reduced-motion rule | `packages/design/src/base.css` (`@unleashed/design/base.css` export) | reuse-as-is | Plain CSS, no Vue. Theme is the `theme` attribute (`[theme="light"]`); dark is the default on `:root`. No `prefers-color-scheme` rule. Global rules a content page must override on purpose: `body { user-select: none }`, hidden scrollbars on `*`. |
| Notched fill | `.ul-notch` in base.css | reuse-as-is | The board's `.n` is the same rule. Every host declares `--ul-fill` and `--ul-notch` (lessons.md). |
| Fonts (Atkinson Next, Mono, Sixtyfour subset) | `packages/design/src/fonts/*.woff2` via base.css `@font-face` | reuse-as-is | 48168 B, 25800 B, 4076 B. Hash-pinned by `fonts.test.ts` against `SOURCES.md`. OFL texts beside them. Never re-vendor. |
| No-inline guard for fonts | `apps/tools/vite.config.ts` `assetsInlineLimit: (f) => f.endsWith(".woff2") ? false : undefined` | adapt (copy one line) | No post-build assertion exists anywhere; the landing's build guard is new. |
| Pixel icons | `packages/design/src/core/icons.ts` (`ICONS`, `PixelIconName`), export `@unleashed/design/core/*` | reuse-as-is | Pure TS data. Has `arrow-right`, `external-link`, `check`, `eye-off`, `zap`, `warning-diamond`, `tv`. Import with the `.ts` extension (needs `allowImportingTsExtensions`). |
| Brand mark path | `apps/tools/src/AppShell.vue` L54-56 `MARK_INK`, signal band `M6 0h2v8h-2z`; `apps/tools/public/favicon.svg` (4x redraw) | adapt | Not exported. `lifi-routing` edits `AppShell.vue`, so this plan adds `packages/design/src/core/mark.ts` and pins it against AppShell's string with a test; moving AppShell onto it is a follow-up. |
| Pre-paint theme | `apps/tools/public/theme-boot.js` | adapt (new, smaller) | Tools reads `localStorage["unleashed:theme"]`. The landing is another origin with no theme control, so its boot reads only `prefers-color-scheme`. |
| `_headers` generation | tools' `headersPlugin` (`closeBundle`, `apply: "build"`) and `cspFor(target)` | adapt the pattern, not the code | Tools' CSP is target-coupled and carries COOP/COEP for bb.js. The landing gets its own headers module, also served by `vite preview` so the smoke runs under the real CSP (the tools pattern). |
| Build identity | tools' `buildMetaPlugin` (`WORKERS_CI_COMMIT_SHA`, else `git rev-parse`) | adapt (copy the idea) | A `<meta name="unleashed-build">` lets the live check prove which commit production serves. |
| Build guard script | `apps/tools/scripts/verify-build-target.ts` | build new | Tools' guard is about `build.json` and manifests. Copy only its shape (offline, `--dist`). |
| Worker config | `apps/tools/wrangler.testnet.jsonc` | adapt | Assets only, `$schema`, `compatibility_date` 2026-08-01, `workers_dev: true`, header comment with the Workers Builds commands, custom domains deliberately absent. |
| Keyed-run template | `apps/tools/cloudflare.env.example` (one key, `op://Keyed-Runs/Cloudflare-Workers/CLOUDFLARE_API_TOKEN`) | reuse-as-is | Its header says "the two Workers"; reword it to stay true. |
| Unit-test config | `vitest.base.ts` `sharedTest` | reuse-as-is | `"test": "bun --bun vitest run"`. Exclude the Playwright folder. |
| Playwright | `@playwright/test` 1.63.0 in tools; `.github/actions/setup-playwright` | adapt | Every tools spec needs the sandbox; nothing to copy but `fixtures/egress.ts`'s idea. The action is hard-wired to `apps/tools`; give it a workspace input. |
| Unit and lint CI | `_lint-and-typecheck.yml`, `_unit-tests.yml` (root `typecheck:all`, `test:all`) | reuse-as-is | Ungated and filter-driven by `@unleashed/*`, so a new workspace is picked up with no edit. |
| Build CI | `pr-quick.yml` `changes` + `build-tools` + `quality-status` | adapt | New filter, output, reusable `_build-landing.yml`, one job read by the existing aggregator. |
| CI pins | `scripts/ci-cd/workspaces.test.ts` (hard list of three workspaces), `behavior-gating.test.ts` (`APPS`, `assertGraphCovered`, aggregator reads exactly its `needs`) | adapt | Both change in the same PR as the workspace. |
| Motion pause, visibility, offscreen | none | build new | Searched `prefers-reduced-motion|visibilitychange|IntersectionObserver|requestAnimationFrame|pause` in `apps/tools/src` and `packages/design/src`: no canvas, no rAF loop, no IntersectionObserver. |
| Deep links to Bridge or Faucet | none | n/a | Tools has no router (`useShell.ts` keeps a module-level section ref). Both links go to the app's origin, as the board does. |

## Facts from the live hosts

- `https://unleashed.systems/`, `/foo?x=1`, `https://www.unleashed.systems/` and `/bar` all answer `302` with `location: https://testnet.app.unleashed.systems/`: the rule drops the path and the query.
- The apex and `www` resolve to Cloudflare anycast addresses (proxied A and AAAA records). The zone's SOA has `minttl` 1800, so a resolver that sees "no such name" during a DNS gap may cache it for 30 minutes.
- `testnet.app.unleashed.systems` sends `strict-transport-security: max-age=31536000` (no `includeSubDomains`) and its CSP from `dist/_headers`.

## Facts from Cloudflare's documentation

- Custom domains: "You cannot create a Custom Domain on a hostname with an existing CNAME DNS record"; Cloudflare's launch post says the setup "will help guide you through the process of creating new records and replace any existing ones". The dashboard path is Worker › Settings › Domains & Routes › Add › Custom Domain. A Worker on the apex does not receive `www`, and the reverse.
- Request phases: `http_request_dynamic_redirect` (Single Redirects) is the first phase; Workers are not in the phase list, and run after it.
- Attach API (`PUT /accounts/{id}/workers/domains`) has `previews_enabled`, which is what "Production only" means in the tools README.

## Docs a launch makes stale

- `README.md` § Hosting: "Two Cloudflare Workers serve…" and "Until a landing page exists, `unleashed.systems` and `www.unleashed.systems` redirect (302) to the testnet app".
- `AGENTS.md` § Hosting ("The app is two assets-only Cloudflare Workers"), the read-before list, the CI summary.
- `apps/tools/README.md` § Production build + hosting (a pointer only), `packages/design/README.md` (a second consumer of base.css).

## Collision and dedup risks

1. `scripts/ci-cd/workspaces.test.ts` fails until it lists `@unleashed/landing`.
2. `behavior-gating.test.ts`: a new job in `quality-status`'s `needs` must be read in its env, and every filter prefix must exist on disk.
3. The root `package.json` and `bun.lock` change, so this PR also runs the six tools e2e shards and the contract suites.
4. Concurrent stack `lifi-routing` edits `AppShell.vue`, `_build-tools.yml`, `biome.json`, `README.md`, `AGENTS.md`, `apps/tools/README.md` and the plan index, lessons and follow-ups. The landing's code PR avoids all of them except `implementations-plan/index.md`; the docs PR reconciles against trunk right before it opens.
5. Editing `.github/actions/setup-playwright` also triggers the tools e2e suite (its filter lists the action).
6. Complexity budgets (cognitive 15, 80 lines a function) are lint errors; the board's `draw()` methods must be split.
7. `*.spec.ts` is in vitest's default include; keep Playwright specs under a folder vitest excludes.
8. Ports: a dev or preview server takes its port from the environment or an ephemeral allocation, never a fixed one the tools harness uses.

## Search trail for the absences

- Mark: `grep -rn "M0 0h1v1h-1z\|MARK_INK"` outside `node_modules`: AppShell.vue, favicon.svg (as a 4x drawing), the board.
- Motion: `grep -rn "prefers-reduced-motion\|visibilitychange\|IntersectionObserver\|requestAnimationFrame"` in `apps/tools/src` and `packages/design/src`.
- `_headers` or `_redirects` files: `find apps packages -name _headers -o -name _redirects` outside `node_modules`: none (tools generates its file at build).
- CSP assertions in tests: `grep -rn "securitypolicyviolation\|Content-Security-Policy"` in `apps/tools/tests`, `apps/tools/src`, `packages`: only `network-targets.ts` and its test.
- Routes: `grep -rn "vue-router\|createRouter\|pushState\|location.hash\|popstate" apps/tools/src`: none.
