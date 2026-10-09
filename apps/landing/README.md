# @unleashed/landing

The page at `unleashed.systems` and `www.unleashed.systems`: the lab's name, a short pitch, and one row per
experiment with a small animated screen. Vanilla TypeScript, no framework. The HTML is rendered at build time,
so the page reads in full with JavaScript off.

## Commands

```bash
bun run --cwd apps/landing dev            # vite on localhost:5177 (LANDING_DEV_PORT overrides)
bun run --cwd apps/landing build          # dist/, then the offline guard; prints DIST_SHA256
bun run --cwd apps/landing test           # unit tests (vitest on Bun)
bun run --cwd apps/landing test:browser   # Chromium smoke over dist/ (build first)
bun run --cwd apps/landing typecheck
```

`test:browser` serves `dist/` from an in-process server on port 0 that applies the built `_headers`, so parallel
runs never share a port. `LANDING_WEBKIT=1` adds WebKit at phone width (CI does not install it).
`LANDING_URL=https://…` checks a live host instead and adds the live-only cases.

## Where things live

| File | Owns |
|---|---|
| `src/content.ts` | Every word on the page, the links, the experiment rows, and `SCREEN_PLACEMENT` |
| `src/markup.ts` | The body HTML, rendered by `vite.config.ts` into `index.html` at build time |
| `src/engines/` | The background dither field and the three card screens, on one frame loop |
| `src/motion.ts` | When motion runs: the visitor's Pause, reduced motion, a hidden tab |
| `security-headers.ts` | The CSP and the other response headers, for `_headers` and `vite preview` |
| `scripts/dist-checks.ts` | The guard over a built `dist/` (CSP, no inline code, links, fonts, sizes, build id) |

Screen placement is provisional, awaiting the owner. `SCREEN_PLACEMENT = "tile"` in `src/content.ts` switches the
rows from Strip to Tile; the Tile rules already ship in `src/styles/landing.css`.

## Hosting

One assets-only Cloudflare Worker, `unleashed-landing` (`wrangler.jsonc`), built and deployed by Workers Builds from
`main`. GitHub Actions only builds and tests it. The config's header lists the commands and variables the dashboard
runs; it never gains `main`, `build` or `alias`.

- **Production** is a build of `main`. `worker:deploy` publishes it and refuses any other `dist/`.
- **Previews** are builds of any other branch (`WORKERS_CI_BRANCH` set and not `main`). `worker:preview` uploads
  one as a version, served at its workers.dev version URL. A preview sends `X-Robots-Tag: noindex` and a robots
  meta, so search engines skip it; `dist/build.json` records `{ buildId, channel }` and each command refuses the
  other channel's build.
- A build's id is `<version>+<first 8 hex of the commit>`, from `WORKERS_CI_COMMIT_SHA` or the local checkout.
  Two builds of one commit give one `DIST_SHA256`; `verify:build --expect <hex> --channel production` checks a
  `dist/` against a known digest.
