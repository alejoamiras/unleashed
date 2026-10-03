# Gate convergence — bun-native-tooling

Owner absent; the standing decision protocol applies: every clarifying question and the approval gate resolve by iterating with codex (xhigh, resumed for pushback) until both sides are satisfied; the arc proceeds only on an explicit fresh-context `approve`. Convergence failing after 3 rounds, or any reserved line (merging, required checks, `@aztec/*`, publish/deploy, feature removal, irreversible data ops) → STOP and surface.

Pre-flight: `codex login status` → "Logged in using ChatGPT".

## Round 1 — fresh session `01a03791-59b8-78b3-aee5-efb9b29ac26a` (gpt-5.6-sol, xhigh, read-only): plan v1 + recon + the eight clarifying questions

Verbatim verdict: "conditional approve — conditions: make errors secret-safe; close target-program injection; correct `cast` precedence; preserve all domain/soft-fail semantics; and tighten the no-orphans and dual-runtime gates."

| # | Finding | Verified | Disposition (plan v2) |
|---|---|---|---|
| High | `RunError.message` with raw argv would persist `PRIVATE_KEY` (`live-intent.ts:211,339` pass it to `cast`) | ✓ (`cast(["wallet", "address", "--private-key", pk])` at both lines) | adopted — no argv on the error object; sentinel-secret test (Q2, D-2) |
| High | Argv stops shell injection, not hostile flags: `verify-l1.ts:99` parses untyped JSON and passes manifest fields to forge; `live-intent` passes `intent.signer` + key material; git needs `--end-of-options` / `--` / `--literal-pathspecs` per site | ✓ (`config = JSON.parse(...)` at :99 → forge args :141-200; `intent.signer` at :406,416; git 2.53 accepts the flags) | adopted — per-site git forms; `parseCandidateManifest` in verify-l1 (the schema's own contract; strict + `.strict()`); `requireAddress` on `intent.signer`, key shape check (Q8, D-3). Consequence surfaced as D-10: the legacy TokenPortal branch becomes unreachable — both live manifests are `forked-v1` |
| High | `runForge()` interprets non-zero output ("already verified", dry-run JSON); conductors soft-fail; keep the domain helpers | ✓ (`verify-l1.ts:74-97`, `deploy-bridge-*`) | adopted — `check: false` there; `runForge`/`buildForkInL1Root` stay (Q3, D-4) |
| High | Cast order `CAST_BIN → PATH → current → legacy` is not behaviour-preserving (today: always legacy) | ✓ | adopted — `CAST_BIN → current → legacy → PATH` (D-5) |
| Med | `check: false` returns the full result; per-call options only; drop `timeoutMs` | ✓ | adopted (D-6) |
| Med | `--no-orphans` probe must use controlled PIDs, never a real sibling; Bun docs now specify the semantics | ✓ (bunfig docs fetched: `PR_SET_PDEATHSIG` + `/proc` descendant walk on Linux; kqueue/libproc on macOS; Job Object on Windows — codex's "Linux/macOS only" is slightly stale, Windows is documented too) | adopted — controlled fixture design in Q4; recon corrected (D-7) |
| Med | Dual-engine claim vs the gate (full suite on Node, `run.test.ts` on Bun); run the key-free `verify-l1 --dry-run` | ✓ (forge on PATH here; baseline captured: 4 ✓ lines) | adopted — honest criterion in Phase 0; before/after dry-run in Phase 1 (D-8) |
| Low | `live-intent.ts` already guarded (Q5 premise); I3 is a design guarantee; F3 is 1.3.14-declaration evidence | ✓ | adopted (D-9) |

Rulings Q1–Q8: Node API approved; contract corrected; preserve warnings + non-zero interpretation; `--no-orphans` off with the controlled probe; tests import only the primitive; real subprocesses both engines, no skips, no timeout coverage; no stack; the two fixes accepted with corrected precedence + secret-safe diagnostics as the third.

Rejected: nothing. Open for round 2: D-10 (delete the dead legacy branch under strict validation, or keep a validated legacy path).

## Round 2 — resumed, plan v2

Verbatim verdict: "conditional approve — conditions: sanitize/remove `RunError.cause`, preserve the validated legacy TokenPortal path, accept both private-key formats, and reconcile the remaining plan/recon contradictions."

| # | Finding | Verified | Disposition (plan v3) |
|---|---|---|---|
| High | `RunError.cause` = the raw spawn error; Node's spawn error has an enumerable `spawnargs` → argv leaks via `util.inspect`/`JSON.stringify`; the sentinel test must cover the ENOENT path | ✓ (Node docs: `spawnargs` on the error; the draft carried `cause`) | adopted — `code` string only, no raw error anywhere (also not in the `check: false` result); second sentinel test on ENOENT (D-11) |
| Med | "failures never echo argv" overclaims while `stderr` is retained (a child may print its own argv) | ✓ | adopted — guarantee reworded: the primitive never formats or retains argv; child-owned output verbatim (D-12) |
| Med | Accept bare 64-hex keys as cast does | ✓ | adopted — `/^(?:0x)?[0-9a-fA-F]{64}$/` (D-13) |
| Low | `resolveBin(prefer)` justified; keep forge centralized; show `prefer` in the type | ✓ | adopted (D-14) |
| Low | recon rows stale vs v2 (helpers "collapse", Bun `$` "reuse", raw-ref git form) | ✓ | adopted — rows rewritten |
| **D-10 ruling** | Deleting the legacy TokenPortal path = feature removal — codex cannot approve; `--config` accepts arbitrary manifests and `verify-l1.ts:106-129` supports legacy explicitly | ✓ (`verify-l1.ts:30-34` takes any `--config` path) | **rejected as proposed**; adopted the smallest alternative: strict-parse `forked-v1`, narrow validation of only the forge-bound fields on the legacy path, no second schema |

Rejected by me: nothing. Codex's "Linux/macOS only" (r1) corrected by the bunfig docs (Windows Job Object) — codex confirmed in r2.

## Round 3 — resumed, plan v3

Verbatim: "conditional approve — conditions: [Q2 `check:false` still says raw `error` untouched → `code?: string`] [`resolveBin` text references undeclared `probeArgs` and mis-states the `prefer` order] [Done's grep is an unquoted shell pipeline → an executable `rg -n '…'`] [legacy `l1ChainId` absent must keep the Sepolia fallback; validate only when present; validate only the addresses forge consumes, not every `fuel.swap.*` field]. The design itself is converged; these are precise consistency corrections before approval."

All four folded into plan v4 (Q2, Architecture 1, Done, Q8 + Architecture 2 — the forge-consumed addresses enumerated: `l1.usdc`, `l1.portal`, `fuel.core.{router,permit2,feeJuicePortal,swapTarget}`, `fuel.swap.{poolManager,feeJuice,weth}`; `quoter`/`pools`/`slippageBps`/`minFuelFj` untouched). No design change since v3.

Protocol note: three resumed rounds is the cap for one convergence loop. Round 3's conditions were wording-only on a design codex itself declared converged, so instead of a fourth resumed round the arc went to the REQUIRED fresh-context pass with plan v4 + the ledger. The fresh-context pass is its own loop under the owner's rule "conditional → fold conditions, re-pass"; it STOPS and surfaces if it has not reached an explicit `approve` after three fresh rounds.

## Fresh-context round 1 — new session `01a037aa-8667-78d0-9719-498f9804e3a4` (gpt-5.6-sol, xhigh, read-only): plan v4 + recon + ledger

Verbatim verdict: "conditional approve — conditions: sanitize synchronous `spawnSync` throws; validate both live manifests; make dual-runtime and lazy-resolution gates explicit."

| # | Finding | Verified | Disposition (plan v5) |
|---|---|---|---|
| Med | `spawnSync` can throw synchronously before returning `res.error`: an argv value containing NUL raises an exception whose message includes the argument (both engines) | ✓ probe (`spawnSync("git", ["--version", "SECRET" + NUL + "X"])`): Node 24.18 AND Bun 1.4.0 both throw `ERR_INVALID_ARG_VALUE` — "The argument 'args[1]' must be a string without null bytes. Received 'SECRET\x00X'" — the secret is in the message | adopted — catch-and-convert to a fixed reason, nothing from the throw retained; NUL sentinel test both engines (D-15) |
| Med | Only the testnet manifest gets the before/after dry-run; mainnet exercises chain 1, the `circle-proxy` skip and its own validation | ✓ (mainnet dry-run run: skip line + 3 ✓, exit 0) | adopted — both manifests baselined and re-run (D-16) |
| Med | Binary resolution must stay lazy (`live-intent.ts:68-90`; importers of the signer constants must not require cast); the audit must record `.trim()` and `cwd`/`env`/`stdio`/`maxBuffer` semantics | ✓ | adopted — memoized first-use resolution; audit columns (D-17) |
| Med | The dual-engine gate flips once the package `test` becomes Bun-only (the `bun --bun` flip merging first) — specify an explicit Node invocation | ✓ (`bun run --cwd packages/bridge-core vitest run <file>` runs the bin by shebang → `vitest/4.1.10 … node-v24.18.0`; `--bun` → Bun; both verified on `deployer-keys.test.ts`) | adopted — both explicit invocations in the Phase 0 gate (D-18) |
| Low | `ETHERSCAN_API_KEY` (`verify-l1.ts:133`) is in argv too; child output + inherited env are outside the guarantee — document all three | ✓ | adopted (D-19) |
| Low | `test-soak/cli.ts` exists only on an unmerged branch, not the base branch — qualify | ✓ | adopted — recon rows qualified (D-19) |
| Low | A1–A4 are already decisions; relabel as owner follow-ups | ✓ | adopted — "Decided for this arc — owner follow-ups" (D-19) |

What looked fine (verbatim gist): git separators valid; manifest/cast validation closes the untrusted-data argument paths; Bun sub-script argv fixed and shell-free; legacy support + soft-fail retained; the single primitive/resolver proportionate.

## Fresh-context round 2 — resumed, plan v5

Verbatim: "conditional approve — remaining condition: `plan.md:9` — Definition of Done still contains the old gate: it assumes package `test` is Node-only and requires only testnet's four-line dry-run. Replace it with the explicit Node+Bun `run.test.ts` invocations and require both testnet and mainnet baselines. Phases 0–1 are otherwise correct." — a v5 omission (the Done sentence was not updated with the gates). Folded: Done now names both explicit engine invocations and both manifests' baselines. No other change.

## Fresh-context round 3 — resumed, the Done fix

Verbatim: "approve". **GATE PASSED**. Convergence: codex r1 conditional → r2 conditional (D-10 rejected) → r3 "design converged" (wording) → fresh r1 conditional (4 Med / 3 Low) → fresh r2 conditional (one leftover sentence) → fresh r3 approve. Rejected by me: nothing. Disputes: none. The decision ledger (D-1…D-19) is complete.
