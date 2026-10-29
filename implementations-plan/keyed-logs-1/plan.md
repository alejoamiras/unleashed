---
plan: keyed-logs-1
tier: light
driver: claude-code
claude_model: opus
codex_model: sol
code_review: off
explainer: off
eli5_mode: skipped (orchestrator-owned)
status: implemented; Codex fix loop converged in 2 rounds
base: main 1f5455f
budget: "recon: 1 Sonnet explorer; code-review: off; Codex gpt-6.1-sol at high"
---

# keyed-logs-1: one redacted entry for every keyed script

## Summary

A keyed script gets the dRPC node URL only from `keyedNodeUrl`, which refuses unless its entry runs through
`runKeyed`; `runKeyed` redacts the SDK log stream and the final failure. Known mid-run prints redact too.

**Requirements.** #46 → a1 (`Closes #46`). Asks: none. **UI impact.** Recorded owner decisions: "(none: no visible
change)". No product surface changes. Operator terminal output changes only by `<NAME>` placeholders and D4.

## Outcome & Quality Bar

**For whom.** The owner, and the agent that runs a keyed command through `env-exec` and reads its output.

**Excellent.** (1) No keyed value (the dRPC key, an L1 RPC URL, a private key, a deployer secret) reaches a
composer's stdout or stderr through the SDK log, the final failure, or a known mid-run print. (2) CI fails a script
that composes the URL other than through `keyedNodeUrl`, and `keyedNodeUrl` fails a run before `runKeyed` starts,
before any client exists. Failures name files, never values.

**Good enough.** Literal values only; output before `runKeyed` starts and new mid-run prints are not guarded
(Security).

## Assumptions

### Facts (verified at 1f5455f; trails in `recon.md`)

1. `requireDrpcNodeUrl(` is called by 14 files: `apps/tools/scripts/deploy-config.ts` (library of `deploy.ts`) and 13
   bridge-core scripts; 12 of the 13 reach an SDK client, `check-fpc-version.ts` only `postNodeRpc` (fixed errors,
   `src/drpc-node.ts:28-60`). Only `deploy.ts` redacts today (`deploy.ts:198-205`).
2. The SDK logs the host on every failed attempt (`foundation/dest/retry/index.js:65`) and the thrown error names it
   (`json-rpc/client/fetch.js:33,47`). The existing child test proves both in 1.2 s.
3. The current helper does not cover what the script prints. Bun's `console.error` bypasses
   `process.stderr.write`, and a top-level-await rejection prints natively (Bun 1.4.2 probe). Nine scripts
   `console.error(e)` raw; `deploy-private-fpc-mainnet.ts` has no catch.
4. Mid-run prints of caught error text: `verify-l1.ts` `fail`/`warn` (`:99-108`, reached in-process from
   `live-intent.ts:925,983`; a probe printed a synthetic key 26 times), `fpc-dust-canary-mainnet.ts:165` (slices to
   160), `script-l1.ts:229` `retryOnRevert` (slices to 120), and `run.ts:54-55` `RunError` (keeps the last 4000
   characters of stderr). Slicing before redaction can keep a key fragment.
5. viem prints the RPC URL in error text and strips only userinfo (`viem/errors/utils.ts:31-37`).
6. Ten scripts import `live-intent.ts`, several only for constants (`fill-testnet.ts`, and through it the relayer
   Worker), so an import-graph rule cannot tell a composer's caller from a constant's reader.
7. The SDK's log lines all go through foundation's root pino logger; `overwriteLoggingStream` replaces its stream
   (`pino-logger.js:351`), so the original transport worker gets nothing after it.

### Inferences

- I1: no SDK module logs a keyed value at import; the only import-time line is `verbose`. Not settled globally:
  import-time output before `runKeyed` is a stated limit.
- I2: `relay-claim-testnet.ts` prints the message only on purpose (`:163`); `describe` keeps that.
- I3: one `keyed-run` instance per process (Bun resolves the workspace link to its real path). A second instance
  fails closed (a refusal), never open.

### Asks (working assumption in force)

- A1 (orchestrator, scope): the standalone entries of `verify-l1.ts`, `pause-factory.ts` and `fill-testnet.ts` print
  viem messages under keyed L1 URLs but compose no node URL. Assumption: their entries stay out (the lane scope
  names node-URL composers); verify-l1's `fail`/`warn` are fixed because live-intent runs them. The close-out files
  one issue for the three entries.

## Architecture & Implementation

Two node-only modules in `packages/bridge-core/scripts/`, never exported from `src/index.ts`:

```ts
// keyed-env.ts — pure; run.ts and the CI test import it without loading the SDK
export const KEYED_ENV: readonly string[] // every name guard rule (2) finds, minus its public list
export function redactSecrets(text: string, env?: Record<string, string | undefined>): string // moved
// keyed-run.ts — exported as @unleashed/bridge-core/keyed-run
/** Installs redacted SDK logging, then marks the process keyed, then runs `main`; a rejection prints redactSecrets(describe(err)) and exits 1. */
export function runKeyed(main: () => Promise<unknown>, describe?: (err: unknown) => string): Promise<void>
/** requireDrpcNodeUrl(network, process.env), refused (fixed message) unless runKeyed has started in this process. */
export function keyedNodeUrl(network: "testnet" | "mainnet"): string
```

`installRedactedLogging`, `LEVELS` and `readable` move into `keyed-run.ts` as private helpers. `describe` defaults to
`inspect(err, { depth: 8, maxStringLength: null })`: the default limit cuts strings at 10 000 characters, which can
leave a key prefix that redaction no longer matches; `deploy.ts` uses the default. Success resolves without exiting. Each entry builds its work inside the closure
(`live-intent`'s `dispatch`, `check-fpc-version`'s `parseNetwork`). Mid-run sites redact first, then slice.

**File map.** New: `keyed-env.ts`, `keyed-run.ts`, `keyed-run.test.ts`, `scripts/ci-cd/keyed-runs.test.ts`.
Modified: the 13 composers (entry, `keyedNodeUrl`); `verify-l1.ts` (`fail`, `warn`); `script-l1.ts:229`; `run.ts`
(`RunError`); `run.test.ts`, `verify-l1.test.ts` (one case each); `apps/tools/scripts/deploy.ts` (`runKeyed`);
`deploy-config.ts` (`nodeUrlFor` → `keyedNodeUrl`; drops the local helper); `deploy-config.test.ts` (child test moves;
`nodeUrlFor` case asserts the refusal, which still proves testnet never reads `AZTEC_NODE_URL`);
`packages/bridge-core/package.json` (one export); `AGENTS.md`, `SECURITY.md` (one clause each).

**Guard** (`keyed-runs.test.ts`, bun:test). (1) No tracked or unignored non-test `.ts` mentions `requireDrpcNodeUrl`
except `src/drpc-node.ts` and `scripts/keyed-run.ts`; a mention, not a call, so an alias or a namespace import counts.
Control: both allowed files do mention it. (2) `KEYED_ENV` holds every env name the non-test scripts read (`env.X`,
`env["X"]`, destructured from `process.env`) or quote, whose suffix is `_KEY`, `_SECRET`, `_SECRET_<NET>`, `_RPC`,
`_RPC_URL` or `_TOKEN`, and every `op://` name in the non-archived templates. A named public list is exempt, each with
its reason: `DEPLOYER_SALT` (a deployed account's salt), `AZTEC_DISABLE_ADMIN_API_KEY` and `AZTEC_RESET_ADMIN_API_KEY`
(boolean switches the sandbox strips), `SANDBOX_L1_RPC` and `SANDBOX_SOURCE_RPC` (loopback URLs). Control: the scan
finds `DRPC_API_KEY` and the three source-RPC names.

## Security & Adversarial Considerations

- **Threat.** The reader of a keyed run's output (an agent transcript, a terminal log) gains a spendable dRPC key, an
  L1 RPC key or a signing key; the boundary crossed is 1Password → that output. No new input, network call,
  dependency or permission. Least privilege, cryptography, supply chain: N/A.
- **Limits.** Matching is literal: a value printed re-encoded, or under a name the pins miss, is not caught. Output
  before `runKeyed` starts and new mid-run prints are reviewed, not guarded. A dummy `runKeyed` beside an unprotected
  `main()` passes the static guard but cannot compose before `runKeyed` starts. Children with captured pipes (`cast`,
  `forge`) reach output only through `RunError`; the two with inherited stdio, in `live-intent` promote, are
  `check-fpc-version.ts` (a composer, so on `runKeyed`) and `verify-deployments.ts` (reads no keyed value).
- **Domain.** Backend/log redaction. The guard reads committed `*.ts` and `*.env.example`, never a `.env` file.

## Phases (arc a1)

### Phase 1: the shared modules, and the tools deploy on them ✓

1. Create `keyed-env.ts` and `keyed-run.ts`; move the helper out of `deploy-config.ts`; add the `./keyed-run` export.
2. Write `keyed-run.test.ts`. (a) A `bun -e` child (`NODE_ENV=production`, `LOG_LEVEL=info`) runs `runKeyed` over a
   node client at `http://127.0.0.1:9/aztec?dkey=<sentinel>` with `makeFetch([0], false)`. Assert exit 1, the retry
   logged, the sentinel absent from stdout and stderr, and `<DRPC_API_KEY>` on the retry line and the failure line.
   (b) A second child, run from `apps/tools`, imports `runKeyed` by the package subpath and `keyedNodeUrl` by its
   relative path: it refuses before `runKeyed` starts and returns the composed URL inside it (settles I3). (c) A third
   child fails inside `runKeyed` with an error whose `stderr` holds 10 000 characters before the sentinel: no
   sentinel fragment prints, `<DRPC_API_KEY>` does. Booleans only.
3. Move `deploy.ts` onto `runKeyed` and `deploy-config.ts` onto `keyedNodeUrl`; adjust `deploy-config.test.ts`.
- **Gate:** `bun run lint`; `bun run typecheck:all`; `cd packages/bridge-core && bun --bun vitest run scripts/keyed-run.test.ts`;
  `cd apps/tools && bun --bun vitest run scripts/deploy-config.test.ts`. Pass: exit 0. Layers: lint, typecheck, unit,
  integration (child process).

### Phase 2: every composer and every known mid-run print ✓

1. Move the 13 entries onto `runKeyed` and their composition onto `keyedNodeUrl`; keep each failure text via `describe`.
2. Wrap `deploy-private-fpc-mainnet.ts`'s top-level await in `runKeyed`.
3. Redact before printing in `verify-l1.ts` `fail`/`warn`, and before slicing at `fpc-dust-canary-mainnet.ts:165`,
   `script-l1.ts:229` and `RunError`. Keep the dust canary's `main` at or below complexity 23.
4. Add one case to `verify-l1.test.ts`: a `Bun.serve` on port 0 answers every call with a JSON-RPC error that viem
   does not retry; with `SEPOLIA_RPC_URL` stubbed to `http://127.0.0.1:<port>/<sentinel>`, `verifyL1Manifest` on the
   committed testnet manifest returns failures, prints `<SEPOLIA_RPC_URL>`, and never prints the sentinel. Planning
   probe at 1f5455f: 1.8 s, 26 sentinel prints (the case fails today).
5. Add one case to `run.test.ts`: a stderr longer than the tail with a keyed value across the cut leaves no fragment.
- **Gate:** Phase 1's commands, then `cd packages/bridge-core && bun --bun vitest run`. Pass: exit 0, and
  `bun run lint` reports no complexity regression. Layers: lint, typecheck, unit, integration (local server).

### Phase 3: the CI guard and the docs ✓

1. Write `scripts/ci-cd/keyed-runs.test.ts`: the two rules above, each with a synthetic self-test (a direct call, an
   alias import, a clean file; an unlisted keyed name) and its tree control.
2. Add the `runKeyed` clause to `AGENTS.md` § Security and `SECURITY.md`.
- **Gate:** `bun run lint:actions`; `bun run test:ci-gating`; `bun run test:all`; `bun run audit:tools`. Pass: exit 0.
  No UI changes, so `e2e:tools` is not run.

## Decision ledger

| # | Decision | Chosen | Rejected, and why |
|---|---|---|---|
| D1 | Failure and mid-run channels | `runKeyed` entry + per-site redaction at the five known prints | a global `console` wrapper: patches a builtin, still misses Bun's native rejection print and every slice-before-print site |
| D2 | Guard | `keyedNodeUrl` refuses outside `runKeyed`; static: one allowed mention | per-file `runKeyed` presence with an importer hop (round 1: presence passes an exported composer called unprotected); import-graph roots (fact 6: false positives up to the relayer Worker) |
| D3 | Names | explicit `KEYED_ENV`, pinned to script reads and templates | a suffix pattern over the ambient env: an unrelated short value would rewrite output |
| D4 | Failure text | each script keeps its own (`describe`) | uniform `inspect`: undoes relay-claim's message-only rule |
| D5 | Home | bridge-core `scripts/`: pure `keyed-env.ts` + SDK-hooking `keyed-run.ts` | one module: `run.ts` and the CI test would load the SDK logger; a new workspace for five functions |

## Audit verdicts

**Codex round 1 (`gpt-6.1-sol`, high): reject.** Every finding verified against the tree; all adopted.

| # | Finding (label) | Disposition |
|---|---|---|
| 1 | High: live-intent runs verify-l1's `fail` in-process; it prints viem messages with the keyed L1 URL (demonstrated; reproduced, 26 prints) | adopted: fact 4, phase 2.3–2.4 |
| 2 | Medium: `RunError` truncates stderr before any redaction, so a key across the cut survives in part (demonstrated for the constructor; real `cast` output plausible) | adopted: phase 2.3, 2.5 |
| 3 | Medium: a presence guard passes an alias import, a dummy call, and an exported composer called by an unprotected importer (demonstrated against the rule) | adopted with a different fix: D2's runtime refusal plus a mention-based guard; the dummy call is a stated limit |
| 4 | Medium: `BASE_RPC_URL`, `ARBITRUM_RPC_URL`, `OPTIMISM_RPC_URL` (`script-l1.ts:102-107`) missing; a template pin cannot see them (plausible) | adopted: guard rule (2) pins script reads |
| 5 | Low: I1 and the SDK-log fact overreach; A1 must not excuse finding 1 | adopted: I1 and fact 7 restated, A1 narrowed |

**Codex round 2 (resumed): conditional approve**, conditions applied. D2 judged proportionate; the accepted fixes and
the 1.8 s regression verified; no disposition reopened.

| # | Finding (label) | Disposition |
|---|---|---|
| 1 | Low: rule (2) would force `AZTEC_*_ADMIN_API_KEY`, public boolean switches, into `KEYED_ENV`; a value `1` would then be redacted everywhere (demonstrated match) | adopted: the named public list; the planner's own scan added destructured reads and the two `SANDBOX_*` loopback names |
| 2 | Low: Quality Bar (2) overstated the static guarantee: a direct `keyedNodeUrl` call outside `runKeyed` passes CI and is refused at runtime (demonstrated against the rules) | adopted: criterion (2) reworded |
| — | Notes: install logging before setting the flag; test the refusal in a child process; repeat the instance check with the real helper | adopted: the `runKeyed` contract, phase 1.2(b) |

**Final fresh Codex pass (new session): conditional approve**, conditions applied. Two-module structure, runtime
refusal, mention-based guard and test selection judged proportionate; A1 fits the issue's scope.

| # | Finding (label) | Disposition |
|---|---|---|
| 1 | Medium: the default `inspect` cuts strings at 10 000 characters before redaction, so a `RunError.stderr` with a key past that point prints a prefix (demonstrated; reproduced in Bun 1.4.2) | adopted: `maxStringLength: null`, test 1.2(c) |
| 2 | Low: phase 3 changes `scripts/ci-cd/` but skipped `lint:actions`, which AGENTS.md requires for CI-script changes (demonstrated) | adopted: phase 3 and delivery gates |
| 3 | Low: the Outcome block asked for a date; AGENTS.md bars calendar dates in plans (demonstrated) | adopted: dropped |
| — | Facts: the child-process line was too broad (`live-intent.ts:1112,1190,1198` inherit stdio) | adopted: Security § Limits names both children |

**Final pass, resumed to verify the conditions: approve.** No regression found.

**Implementation round 1.** Codex (fresh session): 1 finding. Same-family review (Opus, alongside): 4 findings. All
verified and fixed; each new test fails with its fix reverted.

| # | Finding (label) | Disposition |
|---|---|---|
| C1 | Medium: the SDK's debug log `inspect`s node responses with the 10 000-character cut, so a long response prints a key prefix (demonstrated) | fixed: `runKeyed` sets `inspect.defaultOptions.maxStringLength = null`; the old test (c) became an end-to-end debug-response case |
| O1 | The verify-l1 case read the public Base Sepolia RPC and could start `forge build` (demonstrated) | fixed: `sourceRpcUrl` points at the local server, `FORGE_BIN` at an absent binary |
| O2 | The guard missed a hand-built `lb.drpc.live` URL (demonstrated against the rule) | fixed: rule (1) also matches the keyed host and an `env.DRPC_API_KEY` read |
| O3 | An error escaping `main` (a background rejection) prints raw (plausible; no SDK path found) | fixed locally: `runKeyed` routes `unhandledRejection` and `uncaughtException` through the same redacted exit |
| O4 | A test comment gave a wrong reason | fixed: the name is written literally |

**Implementation round 2 (resumed Codex): no material finding.** The fixes verified by probe (no key prefix in the
debug path; escaped errors print once, redacted; success, exit hooks and SIGTERM unchanged; the verifier case makes
no external request; the guard matches only the two allowed files). One Low comment nit, fixed. Converged in 2 rounds.

## Delivery

One arc, one PR against `main`: a1 = phases 1–3 plus the close-out commits, `Closes #46`, code review `off`. Branch
`worktree-keyed-logs-1`; the plan commit is its first commit. Merge `origin/main` before the last gate run. Not
parallelisable: phase 3's guard asserts phase 2's state. Size: over the 150-line target by the two audit tables and
the verbatim review rules; nothing is restated.

## Post-implementation

1. **Codex fix loop** over the net diff from 1f5455f: `~/.claude/skills/codex/scripts/run-codex.sh <prompt-file>
   <worktree> high read-only gpt-6.1-sol`, prompt in `implementations-plan/keyed-logs-1/_codex-diff.md`. Send the
   diff, this plan, the ledger, the adversarial ask, and verbatim: "Report bugs and small, targeted improvements
   only. Do not propose speculative abstractions, extra configuration surface, new layers, or rewrites — the
   smallest change that fixes each real problem. If code works and is clear, leave it alone." and "Audit the comments
   for value per character. Flag any comment that narrates what the code visibly does, restates its line, references
   implementation plans / phases / reviews, or spends a paragraph where a sentence works — and flag places where a
   non-obvious invariant or constraint deserves a comment it doesn't have." Verify each claim, fix, commit, log the
   round in `lessons/phase-3.md`, then `resume-codex.sh "" <followup> <codex-dir> high` until a round has no material
   finding; stop after three rounds and surface. A fix that adds state, a lifecycle, a protocol, a recovery policy or
   a public contract stops for approval.
2. **Delivery.** `bun run test:all`, `bun run lint:actions`, `bun run test:ci-gating`, `bun run audit:tools` green; then `gh pr create`
   (title ≤ 93 characters, Conventional Commit; body: changes, validation with outcomes, `Closes #46`).
3. **Close-out**, as the PR's final commits, after `git merge origin/main` and a read of `index.md` and `lessons.md`:
   the `## Outcome` block after the front matter (status, shipped with the PR number, `Known limits:`,
   `Open items:`, seeds retired); promote generalizable lessons to `lessons.md` (dedupe, retire, under 8 KiB); file A1
   as an issue (`gh issue list --state all --search "viem RPC URL"` first); delete `STATUS.md`; then, in its own
   commit, `git mv implementations-plan/keyed-logs-1 implementations-plan/archive/keyed-logs-1` and add one line to
   `implementations-plan/archive/index.md`. No row in `index.md`. Then `gh pr checks --watch` and report.
4. **Teardown** after the orchestrator merges: `agent-worktree done keyed-logs-1 --merged`; relay a refusal, never
   force.

Where open work lives: a bug or gap → an issue with a `Record` link; a product call → `owner-decision`; a suspected
exploitable weakness → a private draft advisory; a finding needing unsupported conditions → a closed `known-limit`
issue; knowledge → `lessons.md`.

## Seeds (draft; run none)

```
/goal Phases 1–3 of implementations-plan/keyed-logs-1/plan.md marked ✓, each gate reported passing in the transcript; the Codex fix loop converged (a resumed pass quoted with no material finding); the PR exists with Closes #46 and carries the close-out archive commit; bun run test:all and bun run test:ci-gating exit 0.
```

```
/loop 15m Drive implementations-plan/keyed-logs-1/plan.md: read plan.md and lessons/, take the next unticked phase, run its gate exactly, tick it; at the end run Post-implementation 1–3; never merge, sign a keyed run or open a .env file; stop after three failures on one step.
```
