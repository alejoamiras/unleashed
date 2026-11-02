---
plan: sdk-rename-1
tier: light
driver: claude-code
claude_model: opus
codex_model: sol
code_review: off
explainer: off
eli5_mode: skipped (orchestrator-owned)
status: completed (PR #126)
base: main 90e3e8f
budget: "recon: 1 Sonnet explorer; code-review: off; Codex gpt-6.1-sol at high"
---

## Outcome

- **Status:** completed; delivered in PR #126 (one arc), awaiting the orchestrator's merge. Delivers ask52.
- **Shipped:** `@unleashed/sdk` → `@unleashed-systems/sdk` in 208 files plus `bun.lock` (five SDK entries); the
  four scope markers (D3–D5), and one test pinning the scope ban on all three design overrides (D8).
  `pack:check` matches the trunk report except the tarball name.
- **Changed in review:** planning corrected I1, the stale-link check, the pack baseline and the counts.
  Implementation added D8. I2 did not hold: Bun 1.4.2 keeps a renamed workspace's old links until a clean
  reinstall. Rejected: renaming `follow-ups.md:53` (D7).
- **Lessons:** none promoted; `lessons.md` is over its budget. The Bun stale-link and Biome override facts live in
  `lessons/phase-1.md` and in `boundary.test.ts`'s header.
- **Known limits:** none.
- **Open items:** none. Owner's steps: the first `npm publish` under `@unleashed-systems`, its trusted-publisher
  entry and the `npm-publish` environment. PR #121 re-runs the rename on its own imports after this merges.
- **Seeds:** the `/goal` and `/loop` seeds at the end are retired; they are history, not instructions.

# sdk-rename-1: publish the SDK as @unleashed-systems/sdk

## Summary

The SDK workspace is `@unleashed/sdk`, and npm refused its first publish: another account owns that scope. Rename it
to `@unleashed-systems/sdk` in every place outside `implementations-plan/`. Widen the four places that use the
`@unleashed/` scope to mean "a workspace package". The version stays 0.1.0, and nothing the SDK does changes.

**Requirements.** Issues: none. ask52 → a1 (`Delivers ask52`). **UI impact.** Recorded owner decision, ask52: "the
published name is `@unleashed-systems/sdk`. Nothing a user of the app sees changes; the package has no published
consumer yet, so no deprecation or alias is needed." No product surface changes.

Length: about 190 lines, over the `light` target, because the reviewer rules are verbatim and the gate has eight steps.

## Outcome & Quality Bar

**For whom.** The owner, who publishes the first version under the `unleashed-systems` npm org, and the developers
who later read the README and run `npm install`.

**Excellent.** (1) `pack:check` prints `unleashed-systems-sdk-0.1.0.tgz, 178 files`, and every other line equals the
baseline in `recon.md`. (2) No gate silently loses the SDK: `typecheck:all` and `test:all` still run seven
workspaces, the CI-gate graph still holds the SDK, and the design floor still bans it.

**Good enough.** Biome rewraps 10 import statements. Apart from those and the four marker edits, the diff is name lines.

## Assumptions

### Facts (verified at 90e3e8f; trails in `recon.md`)

1. `git grep "@unleashed/sdk" -- ':!implementations-plan'` finds 402 occurrences on 395 lines in 209 files.
2. The scope is a workspace marker in `package.json:21-22`, `scripts/ci-cd/behavior-gating.test.ts:18-23`,
   `biome.json:120,148,180` (pinned by `packages/design/src/boundary.test.ts:62,96`) and
   `scripts/ci-cd/workspaces.test.ts:16-24`.
3. With only the manifest renamed, `bun run --filter '@unleashed/*' typecheck` skips the SDK. Both `'@unleashed*/*'`
   and `'@unleashed{,-systems}/*'` select all seven workspaces, and `Bun.Glob` agrees.
4. `pack-check.ts:164` spells the install path as `"@unleashed", "sdk"`, so a text replace misses it.
5. All nine workspace-to-workspace dependencies use `workspace:*`; no other dependency uses that protocol.
6. `bun pm pack` names the tarball; `publish-sdk.yml` and `pack-check.ts` glob `*.tgz`.
7. On a trial rename, `biome format` rewraps 10 files (`recon.md` lists them).
8. The consumer fixture's manifest and lockfile do not name the SDK. `publish-sdk.test.ts` names neither the package
   nor the tarball.
9. Old-name links exist today only at `{apps/tools,packages/bridge-core,packages/testnet-relayer}/node_modules/@unleashed/sdk`.

### Inferences

- I1. Expected, not guaranteed: `bun install` moves only the five SDK lines of `bun.lock`. The edited manifests may
  re-gate a locked version younger than 7 days (`SECURITY.md` § Dependency policy). A clean install under the
  unchanged policy proves the case; the gate's steps 2–3 run it.
- I2. Expected, not guaranteed: Bun removes the old links. Gate step 2 asserts it. **Did not hold:** Bun 1.4.2 kept
  the three old links; a clean reinstall (what CI does) left none (`lessons/phase-1.md`).

### Asks (working assumption in force)

- None. ask52 is the recorded decision, and the marker edits are technical calls that keep today's behaviour.

## Architecture & Implementation

- **Shape.** No new code. A text replace runs over the git-listed files, except `bun.lock`. `bun install`
  regenerates the lockfile. Biome rewraps the 10 imports. Four marker edits follow, each the smallest edit that keeps
  today's coverage:
  - `package.json` `typecheck:all` and `test:all`: `--filter '@unleashed*/*'` (D3).
  - `behavior-gating.test.ts` `directDeps`: select dependencies whose spec starts with `workspace:`. Take the
    directory from the name's last segment, and say "workspace" in its three comments (D4).
  - `biome.json`: add `"@unleashed-systems/*"` to the three design groups, and say "any workspace package" in their
    three messages. `boundary.test.ts` pins both scopes (D5).
  - `pack-check.ts:164`: `"@unleashed-systems", "sdk"`. `workspaces.test.ts`: the new name sorts first.
- **File map.** The 209 files of Fact 1, plus `biome.json` and `packages/design/src/boundary.test.ts`.
- **Alternative not taken.** Rename all seven workspaces to `@unleashed-systems/*`. It keeps one scope, but moves
  every package, collides with PR #121 on many more lines, and goes beyond ask52 (D1).

## Security & Adversarial Considerations

- **Threat model.** Another npm account owns `@unleashed`. A stale `npm install @unleashed/sdk` in a doc would install
  what that account publishes. Gate step 1 allows no old-name hit outside `implementations-plan/`, whose archive is
  history.
- **Resolution in the repo.** Each dependent declares `workspace:*`, so Bun never fetches `@unleashed-systems/sdk`
  from the registry. Gate step 3 checks the lockfile maps the name to `@workspace:packages/sdk`.
- **Supply chain.** No version moves, and `bunfig.toml` does not change. The publish job is unchanged: it uploads,
  by digest, the one tarball the pack job tested, whatever its name. The first publish, the trusted-publisher entry
  and the `npm-publish` environment stay the owner's steps.
- **CI gates.** D3–D5 keep the SDK in `typecheck:all`, `test:all`, the paths-filter graph and the design floor; a drop
  would let a broken SDK change merge green. N/A: cryptography, frontend, contracts, backend.

## Phases (arc a1)

### Phase 1: rename the package and widen the scope markers ✓

1. Run `git grep -lz "@unleashed/sdk" -- ':!implementations-plan' ':!bun.lock' | xargs -0 sed -i
   's#@unleashed/sdk#@unleashed-systems/sdk#g'`.
2. Run `bun install --frozen-lockfile` and expect it to fail. Then run `bun install`. If the 7-day gate refuses a
   version, record the cause in `lessons/phase-1.md`. Then wait, or add the exclude locally and never commit it.
3. Run `bunx biome format --write` on the files `bunx biome format` lists, and on nothing else.
4. Make the four marker edits from Architecture.
5. Check two edits by mutation, and revert each. First, delete `packages/sdk/src/**` from `pr-tools-e2e.yml`;
   `bun test scripts/ci-cd/behavior-gating.test.ts` must then fail. Second, add `import "@unleashed-systems/sdk"`
   to a file in `packages/design/src/`; `bunx biome check packages/design` must then fail. Log both results.

**Validation gate** (exit 0 unless stated):

1. `git grep -n "@unleashed/sdk" -- ':!implementations-plan'` prints nothing and exits 1.
2. `bun install --frozen-lockfile` passes. `find node_modules apps/*/node_modules packages/*/node_modules -maxdepth 6
   -path '*@unleashed/sdk'` prints nothing (`find` sees dangling links too).
3. `git diff main -- bun.lock` changes only the SDK's lines. Its map entry reads
   `@unleashed-systems/sdk@workspace:packages/sdk`.
4. `bun run lint`. `bun run typecheck:all` and `bun run test:all`, each output naming `@unleashed-systems/sdk`.
5. `bun run test:ci-gating` and `bun run lint:actions`.
6. `bun run audit:tools`.
7. `bun run --cwd packages/sdk pack:check`: line 1 reads `unleashed-systems-sdk-0.1.0.tgz, 178 files`, and the
   other lines equal the baseline in `recon.md`.
8. `bun run e2e:tools -- specs/deposit-token-gas.spec.ts --retries=0`. Before it, run the `forge install` lines from
   `contracts/bridge/evm/README.md` with `--no-git`.

Layers: lint, typecheck, unit, ci-gating, pack, one e2e spec. No new tests: the existing pins prove the rename.

## Decision ledger

- **D1. Rename the SDK only.** Rejected: rename all seven workspaces (see Architecture).
- **D2. Accept Biome's rewrap of 10 imports.** The brief asked for no reformatting, but the lint gate requires it.
- **D3. `'@unleashed*/*'` over `'@unleashed{,-systems}/*'`.** Both select the same seven. `workspaces.test.ts` pins
  the exact name list, so the broader glob cannot add a workspace unnoticed.
- **D4. Select by `workspace:`, not by a scope list.** The protocol states what the test means, and a scope list
  would need another edit at the next rename.
- **D5. Add the scope to all three design groups.** The narrower overrides repeat the restriction, so each needs it.
- **D6. Keep `unleashed-sdk-consumer` and the `unleashed-sdk-pack-check` cache directory.** Neither is the
  package's name.
- **D7. Leave `implementations-plan/` untouched,** `follow-ups.md:53` included, per the brief's boundary.
- **D8 (implementation). Pin the scope ban on all three design overrides.** Biome replaces a narrower override's
  import patterns, and `core` was never pinned (demonstrated by mutation). One test over the three overrides; the
  floor and ui tests keep their trunk text.
- **D9 (implementation). Skip the README's `.env` deletion `find` in `contracts/bridge/evm/lib`.** The lane may not
  search for `.env` files; `lib/` is gitignored and was never read.

## Audit verdicts

| Round | Verdict | Accepted | Rejected |
|---|---|---|---|
| Codex 1 (gpt-6.1-sol, high) | conditional approve | I1 restated as expected, with the failure path (medium, plausible); gate 2 asserts absence with `find`, not `ls` (low, demonstrated: `ls` exits 0 on presence); full baseline in `recon.md` (low, demonstrated); 402 occurrences and exit 1 in gate 1 (low, demonstrated); e2e re-run after a merge that touches its inputs (low, plausible) | none; NUL-safe `git grep -z` adopted from its "fine" list |
| Codex final (fresh session) | conditional approve | the baseline's peers line was truncated by my capture, so gate 7 could not pass: `recon.md` now holds the report byte for byte (medium, demonstrated); the e2e re-run after a merge follows the `pr-tools-e2e.yml` filter (low, plausible) | none |
| Codex final, resumed | **approve** | both corrections verified; no remaining findings | none |
| Impl. round 1: Codex (session 01a19e24) + Opus review | Codex clean; Opus clean with one low | Opus: the `core` override's scope ban was unpinned (low, demonstrated) → D8 | Opus: `follow-ups.md:53` (D7 holds) |
| Impl. round 2: Codex resumed | **clean** | D8 verified, no regressions | none |

## Delivery

One arc, one PR against `main`: a1 = Phase 1, `code_review: off`. Title: `refactor(sdk): rename the package to
@unleashed-systems/sdk`. Body: the changes and why (the marker edits named), each gate's outcome, the e2e spec's
wall-clock, the note that PR #121 must re-run the rename on its new imports, `Delivers ask52`. No parallel lanes.

## Post-implementation

1. **Codex fix loop** over the net diff from the plan commit: `~/.claude/skills/codex/scripts/run-codex.sh
   <prompt-file> <worktree> high read-only gpt-6.1-sol`, prompt in `_codex-diff.md` here. Send: the marker edits and
   rewraps in full, the name-only hunks as a list, this plan, and the adversarial ask (a missed occurrence, a gate
   that lost the SDK, a registry resolution of the new name). Add the `.env`, `~/.agents/orchy/`, `orchy.sh` and
   viewer-socket prohibitions, and both rules verbatim: "Report bugs and small, targeted improvements only. Do not
   propose speculative abstractions, extra configuration surface, new layers, or rewrites — the smallest change that
   fixes each real problem. If code works and is clear, leave it alone." and "Audit the comments for value per
   character. Flag any comment that narrates what the code visibly does, restates its line, references
   implementation plans / phases / reviews, or spends a paragraph where a sentence works — and flag places where a
   non-obvious invariant or constraint deserves a comment it doesn't have." Verify each claim, fix, commit and log the
   round. Then `resume-codex.sh "" <followup> <codex-dir> high` until a round finds nothing material. After three
   rounds, stop and surface. A fix that adds state, a lifecycle, a protocol, a recovery policy or a public contract
   stops for approval.
2. **Delivery.** `git merge origin/main`, then gate steps 1–7. Run step 8 again if the merge changed any path in
   the `pr-tools-e2e.yml` `changes` filter; else record that it did not. Then `gh pr create` per Delivery.
3. **Close-out**, as the PR's final commits, after reading what `origin/main` changed in `index.md` and
   `lessons.md`. Write `## Outcome` after the front matter: status, PR number, `Known limits:`, `Open items:`, seeds
   retired. Promote only a lesson that generalizes (dedupe, retire, stay under 8 KiB). Delete `STATUS.md`. Then, in
   its own commit, `git mv implementations-plan/sdk-rename-1 implementations-plan/archive/sdk-rename-1` and add one
   line to `archive/index.md`; no row in `index.md`. Then `gh pr checks --watch` and report.
4. **Teardown** after the orchestrator merges: `agent-worktree done sdk-rename-1 --merged`. Relay a refusal; never
   force.
5. **Owner's steps:** the first `npm publish` under `@unleashed-systems`, its trusted-publisher entry and the
   `npm-publish` environment (`packages/sdk/README.md` § Releasing).

Open work: a bug or gap → an issue with a `Record` link; a product call → `owner-decision`; a suspected exploitable
weakness → a private draft advisory; unsupported conditions → a closed `known-limit` issue; knowledge → `lessons.md`.

## Seeds (draft; run none)

```
/goal Phase 1 of implementations-plan/sdk-rename-1/plan.md marked ✓ with its gate reported passing in the transcript; the Codex fix loop converged (a resumed pass quoted with no material finding); the PR exists with Delivers ask52 and carries the close-out archive commit; bun run test:all and bun run lint exit 0.
```

```
/loop 15m Drive implementations-plan/sdk-rename-1/plan.md: read plan.md and lessons/, take the next unticked step, run its gate exactly, tick it; at the end run Post-implementation 1–3; never merge, publish or open a .env file; stop after three failures on one step.
```
