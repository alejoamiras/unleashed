# Post-implementation review loop

## `/code-review max --fix` (implementation diff `git diff <rev> -- . ':!implementations-plan'`, 11 files, +379/−61)

Read in full: `run.ts`, `run.test.ts`, the six migrated scripts' diffs, `candidate-schema.ts` (one `export`), README, `.env.example`. Checked each of the 18 audit rows against the code: `check: false` exactly where a caller interprets failure (`runForge`, `buildForkInL1Root`, the two conductors); `status --porcelain` read untrimmed (leading-space status lines feed `l.slice(3)`); `git()` (trimmed) only where trimming is neutral; `forgeBin()`/`castBin()` memoized and lazy (import probe green); the `forge()` wrapper in `verify-l1.ts` keeps the file's `console.error` + `exit(1)` idiom; the legacy validator covers exactly the forge-bound fields and nothing else; the conductors' soft-fail reads `exitCode !== 0`, which also covers a spawn failure (`exitCode: null`), as `status !== 0` did.

Findings: **none requiring a change.** Two judgement calls left as they are: `run()`'s catch-all converts ANY synchronous throw into `invalid argument` (by design — a thrown spawn error must never be retained; the typed API leaves no other throw class in practice); `resolveBin` returns an env override verbatim without existence-checking it (the operator's explicit choice; the failing spawn names it).

No `fix(review)` commit.

## Codex post-impl round 1 — fresh session `01a037c6-4853-7fe1-9df8-efcf8c7a9264` (gpt-5.6-sol, xhigh, read-only): **conditional approve**

Verbatim: "conditional approve — conditions: correct the secrecy overclaim, add `check:false` secrecy coverage, isolate resolver tests from ambient env, then run the required resumed audit before opening a PR." High: none.

| # | Finding | Verified | Fix (`fix(review)` commit) |
|---|---|---|---|
| Med | `live-intent.ts:101` comment says `run` "never echoes argv in a failure" — false in the presence of child stderr (codex reproduced: a child that prints its own argv puts the secret on all four surfaces); the documented child-output boundary, but a dangerous assurance next to key handling | ✓ | comment reworded ("adds nothing from argv to a failure — what `cast` itself prints to stderr is kept verbatim"); `run.ts` header states the three boundaries |
| Low | the `check: false` secrecy contract is untested (the ENOENT case checked only `.code`; a regression returning the raw `error`/`spawnargs` would pass) | ✓ | new case: the ENOENT `check: false` result has exactly the keys `code, exitCode, signal, stderr, stdout` and neither `inspect` nor `JSON.stringify` contains the secret |
| Low | resolver tests assume `RUN_TEST_UNSET` is unset (`RUN_TEST_UNSET=/operator/tool` bypasses candidate/PATH/not-found); `RUN_TEST_BIN` not restored | ✓ | `beforeAll` clears both, `afterAll` restores prior values |

What looked fine (verbatim gist): the scoped guarantee holds (no argv / raw spawn error stored; synchronous throws → fixed reason; `check: false` returns only scalar status + child text); git boundaries correct against 2.53; no shell/flag injection left through git/forge/cast/bun for the reviewed inputs; exit handling, soft-fails, trimming, options, laziness, resolver order match prior behaviour; strict validation rejects only incomplete/custom `forked-v1` JSON, never a valid current candidate; the legacy path remains usable.

## Codex post-impl round 2 (resumed) — **APPROVE — LOOP CONVERGED** (r1 conditional → r2 approve)

Verbatim: "approve". No code changed after `fix(review)`. Delivery follows: one PR to the base branch, the three required checks asserted at its HEAD, merge reserved for the owner.

## Base-branch merge resolution (post-approve)

Merging the base branch: two conflicts. `implementations-plan/index.md` — row union (the base branch's rows, this arc's row kept). `packages/bridge-core/scripts/verify-l1.ts` — the base branch had added a remappings guard (`generateRemappings()` + `assertEffectiveRemapping(forgeBin())`) into the file this arc rewrote; resolved as the union: this arc's structure + the guard, called through the `forge()` wrapper. Because the base branch's `gen-remappings.ts` carried two direct `spawnSync` sites, it was migrated to `run(..., { check: false })` in the same resolution commit — keeping the "spawn only through run.ts" invariant true on the merged tree (the `rg` check stays run.ts-only). Verified at the merge commit: frozen install (v2 lockfile, isolated linker), typecheck, 238 package tests, biome, lint, and `verify:l1 --dry-run` printing the `remappings OK` line (forge 1.7.1, the isolated-layout l1-artifacts path) followed by the four baseline ✓ lines — the remappings resolver and this arc's primitive proven together.
