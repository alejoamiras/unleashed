# Phase 6: merge PR 1, create the Worker with Workers Builds

The owner's second answer (quoted in plan.md, Owner verdict) drops the keyed run. The owner creates the
Worker with Workers Builds' Import a repository after PR 1 merges, reusing the app Workers' build token
(ledger D15). Phase 6 and runbooks O1 and O2 are rewritten for it.

- **The import needs the root directory at `apps/landing`.** Cloudflare's builds docs: the root directory
  is where the commands run and where the Wrangler file is read, and the Worker's name must equal that
  file's `name`. An import whose root directory has no Wrangler file runs automatic configuration,
  which opens a pull request with a generated config. The tools Workers keep the repository root only
  because they were connected to existing Workers, not imported.
- **So the build command starts with `cd ../..`.** The frozen, filtered install must run at the
  repository root, where `bun.lock` is. Simulated on a `git archive` export of `b2dea77`, from
  `apps/landing`, with `WORKERS_CI_BRANCH=main` and the commit as `WORKERS_CI_COMMIT_SHA`: 201 packages,
  build and guard pass, and the digest equals the worktree's at that commit (`05979a3a…`). In the same
  export `worker:preview` refuses the production `dist/`.
- **`SKIP_DEPENDENCY_INSTALL=1` matters more now.** Without it Workers Builds would install on its own in
  `apps/landing`, which has a manifest and no lockfile, so npm would meet the `workspace:*` links.
- **The first upload has no gate before it.** What replaces K1's pre-upload check is the check after:
  the build log's `DIST_SHA256` against a reference build of the merge commit, and the live smoke from
  that export on workers.dev, before any domain points at the Worker.
- **NEL is a zone setting** (the zone's Network page, Network Error Logging Monitoring; the `nel`
  zone setting in the API). Turning it off reaches the app hosts too; the owner accepted that.
- **Cloudflare's builds docs now name the non-production command "Preview command"**, defaulting to
  `npx wrangler preview`. `worker:preview` (`wrangler versions upload`) is the landing's, as the tools
  app's `versions upload` already is on `unleashed-testnet`.

## The local WebKit gate (libgtk-4-1 4.14.5 installed by the owner)

WebKit launches now. The first pass, `LANDING_WEBKIT=1 test:browser`, gave 25 of 27, and repeats
failed different motion and readback checks each time. Three causes, all in the harness:

- **Mobile WebKit has no mouse wheel** (`mouse.wheel: Mouse wheel is not supported in mobile WebKit`).
  The clean-load case now scrolls with `window.scrollTo`.
- **`cards.spec.ts` forced a 1440 x 2000 viewport on every project**, so the phone project ran the
  cards at desktop width with the iPhone's 3x scale: about 4 frames a second in software-rendered
  WebKit, measured (58 at 390 x 844). The spec now keeps the project's width and only sets the height.
- **Playwright's default is half the cores: 94 workers on this host.** Past about eight parallel
  pages, software-rendered WebKit starves and the motion polls time out (161 of 162 at the default,
  162 of 162 at eight). A WebKit run is capped at eight workers in the config; Chromium keeps the
  default.

After the fixes: both projects, `--repeat-each=3`, twice: 162 of 162 each time.

LESSONS_FILE=implementations-plan/landing/lessons/phase-6.md
