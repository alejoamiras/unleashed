## Outcome

Archived. Seeds retired.

# operator-gates — round 3, plan 3 (BL/C, 1–2 PRs)

Six directives: `packages/bridge-core/scripts/live-intent.ts` `verify` (91 lines, cognitive 61) and
`promote` (91 lines, 35) — four directives; `scripts/ci-cd/test-soak/lib.ts` `compareSummaries`
(41) and its inner `checkSide` (31) — two. Manifest 41 → 35. `eli5_mode: none`; recon: self-read;
code-review: codex (one session).

## Why these are REFACTOR, not ACCEPT

`verify` is not one procedure: it is nine independent, non-broadcasting security gates (intent
committed, tree discipline, source unchanged since build, identity, signer, artifact digests,
candidate digest pin + privileged L1 readbacks, spend-within-caps) bundled into one 90-line body
whose only structure is comment headers. `promote` is likewise a fixed sequence of nine stages
(digest required → the full gate → FPC require-deployed → symlink rejection → read-once + byte
pin → drip derivation → zero-seed → atomic writes + re-hash → re-verify live → receipt). Every one
of those has a review finding number attached and a `— STOP` string a human greps for during a
live arc. Named gates make each finding's guard a function a reviewer can read in isolation and a
test can exercise without a broadcast — that is the merit, and it is exactly what "run-once
tooling" was hiding. `compareSummaries` is the same shape in miniature: metadata, per-side,
inventory, resolution and report checks in one closure that mutates `problems`.

## PR-a — `live-intent` (BL/C; 4 directives, 41 → 37)

**Commit 1 — pins FIRST, against the current code**: `live-intent.pins.test.ts` (vitest, Bun
runtime) exercising `verify` and `promote` end-to-end with **injected runners, never a broadcast**:
`vi.mock("./run")` (`run`, `git`, `resolveBin` → scripted by argv), `vi.stubGlobal("fetch")` for
`rpc()` (node identity), and an in-memory `node:fs` fake (`readFileSync`/`writeFileSync`/
`renameSync`/`rmSync`/`lstatSync`/`mkdirSync` keyed by path, with symlink flags). `verify` and
`promote` become `export`ed (the CLI dispatch is already `isMain`-guarded). Pins, one per STOP:
intent uncommitted; non-allowlisted dirty tree; deploy-relevant change since build (and the
allowlisted-only case passing); malformed `source.commit`; rollupVersion moved; nodeVersion moved;
rollup address moved; signer mismatch (and the no-`PRIVATE_KEY` skip); Noir artifact drift;
canonical PrivateFPC drift; candidate digest changed vs recorded; first-verify digest RECORDING
(writes the intent); candidate portal/asset/handler pins vs intent; `UNDERLYING()` and
`FEE_ASSET()` readback mismatches; handler absent (mainnet posture) skips the handler checks;
router `owner()` / `swapTarget()`; spend over cap vs within cap (exact ✓ log lines, incl. the
legacy no-baseline line). `promote`: missing recorded digest; symlinked candidate/live target;
missing candidate; `--bridge-only` without a live drip manifest; bytes changed between verify and
promote; zero-seed violation (delegated to the real `assertZeroSeed`); re-hash mismatch after
write; `--bridge-only` live drip pin violated; the receipt's exact fields for the three zero-seed
modes; write order (temp → `wx` → rename) and the pre-planted tmp removal. Each pin asserts the
exact error text and the argv the runner saw (order included). Expected: ~30 cases in two
`describe`s.

**Commit 2 — the split** (bodies verbatim, every string preserved):
- `verify` = `readIntent` → `requireSepolia` → `assertIntentCommitted(intentPath, intent)` →
  `assertTreeDiscipline()` → `assertSourceUnchangedSinceBuild(intent)` →
  `assertIdentityUnmoved(intent)` (returns `now`) → `assertSignerUnchanged(intent)` →
  `assertArtifactDigests(intent)` → `if (candidatePath) verifyCandidate(intent, intentPath,
  candidatePath, sepolia)` → `assertSpendWithinCaps(intent, sepolia, now)`.
  `verifyCandidate` = `pinCandidateDigest` (compare-or-record) → `parseCandidateManifest` →
  `assertFeeJuiceReadbacks(candidate, intent, sepolia)` → `assertFuelReadbacks(candidate, intent,
  sepolia)` → the ✓ line.
- `promote` = `requireRecordedDigest` → `await verify(...)` → the FPC `run` → `rejectSymlinks` →
  `readCandidatesOnce` (bytes, shas, the drip live pin, the byte-pin check, parse + drip shape +
  derivation `run`) → `assertZeroSeedCarry` → `writeAtomically(writes)` → `reverifyLive` →
  `writeReceipt`. Path constants computed once at the top and passed down.
- Nothing async is introduced or removed: `verify`'s only awaits are `probeIdentity` (inside
  `assertIdentityUnmoved`) and `promote`'s `await verify(...)` — the same two awaits, in the same
  positions.

Gates: `packages/bridge-core` unit suite (incl. the new pins, zero-edit green across the two
commits), `audit:vue`, `test:ci-gating`. No e2e touches these scripts;
never a testnet invocation.

## PR-b — `test-soak/lib.ts` (BL/E over the existing `lib.test.ts`; 2 directives, 37 → 35)

`compareSummaries(a, b)` → `checkMeta(a, b): string[]` · `checkSide(side, label, expectBun):
string[]` (explicit inputs, returns problems — no outer-state mutation) · `checkInventories(a,
b): { problems, lines }` · `checkResolutions(a, b): { problems, lines }` · `buildReport(a, b,
lines, problems)`; `compareSummaries` concatenates in the existing order (meta → reference side →
candidate side → inventories → resolutions → report) so `problems`/`lines` ordering — and thus the
report text — is byte-identical. Existing `lib.test.ts` cases zero-edit green + one focused test
per validator on its own inputs.

## Codex blueprint conditions (folded)

- **Ladders verbatim.** `verify`: read intent + require RPC → committed-intent check ONLY when
  `candidateSha256` exists → tree discipline → source diff (only when `source.commit`) →
  `probeIdentity` (the sole await; everything before it completes first, `now` feeds the final
  log) → signer (skipped without `PRIVATE_KEY`) → artifacts → candidate → spend. Candidate:
  digest mismatch → strict parse → record digest + write intent + log → privileged readbacks —
  so an INVALID manifest never rewrites the intent, while a valid manifest whose readback fails
  DOES leave the digest recorded (both pinned; "record after all checks" would not be verbatim).
  `promote`: require digest → `await verify` → FPC gate → symlink checks (not before FPC) →
  read-once (a second, deliberate read distinct from verify's) → drip shape + derivation →
  zero-seed → per-target `rm(tmp)` → `wx` → rename → re-hash, bridge BEFORE drip, no rollback →
  live re-parse + derivation gate + bridge-only pin → receipt.
- **Missing-candidate matrix**: initial absence fails inside `verify` first; the promote-side
  "candidate missing" branch is reachable only when the bridge candidate vanishes between verify
  and `lstat`; the drip candidate missing is its own case.
- **Harness = default-deny + one event stream.** Every `run`/`git`/`resolveBin`/`fetch`/fs
  access not scripted for the case throws; all of them append to one ordered event log. Pins =
  ONE byte-exact green trace (argv order, fs writes, exact ✓ lines `:397`/`:440`/`:454-460`/`:633`)
  plus per-failure cases asserting the failing call happened and NO later stage ran (table-driven
  for identity and path variants). Do not re-pin the schema and zero-seed matrices already in
  `candidate-schema.test.ts` / `promotion.test.ts` — pin their integration and flag forwarding.
- **Essential cases added**: FPC-gate failure → no fs mutation; drip derivation failure → no
  writes; live re-verification failure → no receipt; schema failure → digest NOT recorded;
  readback failure → digest recorded; first-target re-hash failure → second target not written;
  `git rev-parse` / receipt only after live verification.
- **Fs-fake contract test on a real temp dir**: `wx` against a regular file and a dangling
  symlink, `lstat` of a broken symlink, rename over an existing target, Buffer vs utf8 reads,
  error codes — the overlay must match those observations.
- **Positive control first**: one sentinel pin proving `vi.mock("node:fs")` intercepts this
  script's named imports under the Bun-runtime vitest config before the suite is built on it.
- **`castPath` is module-cached**: resolution stays invariant across cases (`resolveBin` → "cast"
  always), never relying on spy resets.
- **Commit 1 stated honestly**: an export-only production seam (`verify`, `promote`, and the
  test-soak validators) plus characterization pins — not literally zero production change.
- **Shape**: keep the module's own `run`/`git`/`cast`/`fetch` (mocked at their boundaries);
  `verifyCandidate` with digest recording between parse and readbacks; promotion paths as ONE
  typed object computed once; validators return `string[]` / `{ problems, lines }` (never
  passed-in mutable arrays), exported for direct tests; one exact multi-failure report golden for
  `compareSummaries` (existing tests use `contains`).
- **Owner dispositions (behavior preserved, surfaced in the PR body)**: `--drop-swap` and
  `--restore-swap` together are both accepted by `assertZeroSeed` and the receipt reports
  RESTORED (the ternary wins) — pinned as-is; a malformed/NaN balance or cap passes the
  `spent > cap` test — pinned as-is. Both are candidates for a follow-up hardening, never fixed
  in passing here.

## Codex loop

Fresh session for the plan: blueprint audit (adversarial on the gate boundaries: what a split
could reorder, which STOP could become reachable/unreachable, whether exporting `verify`/`promote`
widens anything, whether the in-memory fs fake can mask a real-fs behavior the pins rely on —
`wx` semantics, rename atomicity, symlink detection) → fold → PR-a review → PR-b review →
approve. Ledger in `lessons/phase-1.md`.

## Assumptions

Facts: the four `live-intent` directives are at 305/306 and 487/488; `run`/`git`/`resolveBin`
come from `./run`; the node is reached only through `rpc()` (global `fetch`); `promote` writes
under `repoRoot` derived from `import.meta.url` (so pins MUST fake `node:fs`, never touch the
tree); `compareSummaries` has existing tests. Inference: `vi.mock("node:fs")` with named-export
fakes intercepts the script's `import { … } from "node:fs"` under the Bun-runtime vitest config
(the same mechanism the store suites use for `@/` modules) — verified by the first pin. Ask: none.

## Security & adversarial

These ARE the security gates for testnet promotion. Risks: (1) a gate silently dropped or
reordered — the pins enumerate every STOP and the green path's argv order; (2) `export`ing
`verify`/`promote` — the CLI guard is unchanged, no new entry point; (3) a fake fs that is more
permissive than the real one (e.g. `wx` on an existing path) — the fake throws `EEXIST` on `wx`
and models symlinks; (4) the pins must never read `process.env.PRIVATE_KEY` from the real env —
each test sets its own env and restores it.
