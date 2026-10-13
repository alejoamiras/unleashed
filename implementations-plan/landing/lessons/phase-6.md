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

## Merge

PR 1 (#15) squash-merged at `bf6596d` with every required check green (28 passed, Shellcheck skipped
by its filter): `1dd4aec`, verified by GitHub. Marking it ready fired `ready_for_review`, which
cancelled the in-flight `synchronize` runs; their aggregators showed as failed until the new runs
finished. That is the concurrency group working, not a break.

Reference build of `1dd4aec` (export, root directory `apps/landing`, O1's build command,
`WORKERS_CI_BRANCH=main`): `DIST_SHA256=91ff95ac81c0072c431a9130b1ff2f0eddf7c2e0970d0c6606749c001b807d4c`.
The first Workers Builds deploy must print the same.

## The first Workers Builds build (O1)

The owner imported the repository with the token "Unleashed Builds". The install ran as designed:
`SKIP_DEPENDENCY_INSTALL` honoured, then the filtered, frozen install (201 packages). Then `vite build`
failed: `no build identity: WORKERS_CI_COMMIT_SHA or a git checkout, got 'main'`. Nothing deployed.

- **Workers Builds put the branch name in `WORKERS_CI_COMMIT_SHA`** on that first build, which no push
  triggered. `||` only falls back on an empty value, so the strict 40-hex check saw `main` and failed.
  The tools build slices the variable unchecked and would have shipped `<version>+main`
  (`follow-ups.md`).
- **Fix, PR #16 (`4c33c63`):** `apps/landing/build-commit.ts` uses the variable only when it is a full
  SHA, else `git rev-parse HEAD` (Workers Builds builds from a clone), else fails. A local build with
  `WORKERS_CI_COMMIT_SHA=main` in a checkout gave the reference digest. The fix branch's own preview
  build on `unleashed-landing` passed before the merge.
- **The merge's production build deployed:** build id `0.1.0+4c33c630` on workers.dev. Reference build
  of `4c33c63` (export, O1's command): `DIST_SHA256=a66f05f4cb69ec658c862979eeba961e0ce966d05bf4d7506199f5ea23cc56f7`.
  From that export, `LANDING_URL=https://unleashed-landing.alejo-amiras.workers.dev LANDING_WEBKIT=1
  test:browser`: 56 passed, the live-only cases included (served HTML byte-identical to the reference,
  no `/cdn-cgi/` request). The build log's digest is still to be compared (the owner sends it).
- **workers.dev also sends `nel` and `report-to`.** NEL there is not the zone's setting, so O2's
  "no `nel`" check belongs on the custom domains only.

LESSONS_FILE=implementations-plan/landing/lessons/phase-6.md
