# Phase 1 — Call-site migration (six commits) — lessons

One commit per file, in the plan's order. Every row of the static audit: the old API → the new call; `cwd`/`env`/`stdio`/`maxBuffer`; `.trim()`; the exit-code path; soft-fail preserved?; validation added?; resolution lazy?

## portal-artifact.ts (commit 1)

| # | site (old) | new call | options | exit path | soft-fail | validation | lazy |
|---|---|---|---|---|---|---|---|
| 1 | `:49` `spawnSync("forge", ["--version"], { stdio: "ignore" })` inside `forgeBin()` | `resolveBin("forge", { envVar: "FORGE_BIN", candidates: [~/.aztec/current/bin/forge], prefer: "path" })` — the PATH probe is `run(name, ["--version"], { check: false, stdio: "ignore" })` | same probe, same order (env → PATH → `~/.aztec/current/bin/forge`) | not-found → `Error` (message text now names the env var, PATH and the candidate; was "forge not found - install foundry or set FORGE_BIN.") | n/a | n/a | **yes** — memoized on first call; previously re-probed on every `forgeBin()` call |
| 2 | `:88` `spawnSync(forgeBin(), ["build", STAGE_REL, "--use", solc], { cwd, env, encoding, maxBuffer 64 MiB })` | `run(forgeBin(), [same args], { cwd: l1Root, env, maxBuffer: 64 MiB, check: false })` | identical (`encoding: "utf8"` is the primitive's default; `stdio` default = pipes, as before) | `res.exitCode !== 0` → `throw Error("forge build failed:\n<stdout><stderr>")` — same condition (`status !== 0` covered spawn failure too: `null !== 0`), same message (`?? ""` no longer needed: the primitive never yields null text) | n/a (throws, as before) | inputs are constants | n/a |

Gate after the file: typecheck clean · package tests 237 passed / 4 skipped · biome clean.

## verify-l1.ts (commit 2; `src/candidate-schema.ts` exports `evmAddress`)

| # | site (old) | new call | options | exit path | soft-fail | validation | lazy |
|---|---|---|---|---|---|---|---|
| 3 | `:49` local `forgeBin()` probe (`spawnSync("forge", ["--version"])`, then `~/.aztec/current/bin/forge`, else `console.error` + `process.exit(1)`) | deleted; `forge()` wraps the shared `forgeBin()` from `portal-artifact.ts` and keeps the file's `console.error` + `exit(1)` on not-found | same order | same (message text from `resolveBin`) | n/a | n/a | yes (memoized) |
| 4 | `:77` `spawnSync(forgeBin(), args, { cwd: root, env, encoding, maxBuffer 64 MiB })` in `runForge()` | `run(forge(), args, { cwd: root, env, maxBuffer: 64 MiB, check: false })` | identical | `res.exitCode === 0 \|\| /already verified/i` (was `res.status === 0 …`); dry-run `JSON.parse(res.stdout)`; `out` = stdout+stderr (no `?? ""` needed) | **preserved** — `runForge` returns a boolean, the five callers AND them into `process.exit(ok ? 0 : 1)` | **added**: after `JSON.parse(CONFIG_PATH)` — `forked-v1` → `parseCandidateManifest` (strict), else `requireLegacyForgeInputs` (only `l1.usdc`, `l1.portal`, `fuel.core.{router,permit2,feeJuicePortal,swapTarget}`, `fuel.swap.{poolManager,feeJuice,weth}`, `token.sourceContract` enum, `l1ChainId` positive int when present); failures `console.error` + `exit(1)` like every other check in the file; absent `l1ChainId` keeps the Sepolia fallback | yes |

Behaviour checks: `verify:l1 --dry-run` (testnet) and `--config apps/faucet/public/mainnet-bridge.json --dry-run` print exactly the Phase 0 baselines (4 ✓ / skip + 3 ✓), exit 0. Negative probe: a legacy-shaped manifest with `"usdc": "nope"` → `bridge manifest l1.usdc is not a 20-byte 0x address: "nope"`, exit 1, before any forge invocation. Gate: typecheck clean · 237 passed · biome clean.

## live-intent.ts (commit 3)

| # | site (old) | new call | options | exit path | soft-fail | validation | lazy |
|---|---|---|---|---|---|---|---|
| 5 | `:90` `execFileSync(CAST, args, { encoding, stdio: ["ignore","pipe","pipe"] }).trim()` in `cast()` (`CAST` = `HOME ?? "~"` + `.aztec/versions/5.0.0/internal-bin/cast`, a module-level constant) | `run(castBin(), args, { stdio: ["ignore", "pipe", "pipe"] }).stdout.trim()`; `castBin()` = `resolveBin("cast", { envVar: "CAST_BIN", candidates: [~/.aztec/current/internal-bin/cast, ~/.aztec/versions/5.0.0/internal-bin/cast], prefer: "candidates" })` | same stdio; `.trim()` kept | throws `RunError` (was: `execFileSync` threw with the full argv — the deployer key — in `Command failed: …`) → `run.catch` prints `✗ <message>` and exits 1, as before | n/a | **added**: `requirePrivateKey(pk)` (`/^(?:0x)?[0-9a-fA-F]{64}$/`) before both `wallet address --private-key` sites (`build`, `verify`); `requireAddress(intent.signer, "intent signer")` before the `balance` readback; node/candidate addresses were already validated | **yes** — `castBin()` memoizes on first call; importing the module for `PLAN_PINNED_L1_SIGNER` resolves nothing (probe below). The `"~"` never-expanded fallback is gone (`homedir()`) |
| 6 | `:164` `execSync("git show HEAD:implementations-plan/…/intent.json")` | `git(["show", "HEAD:…/intent.json"], repoRoot)` | cwd repoRoot; trimmed (JSON.parse-neutral) | throws `RunError` (was: `execSync` threw) → same `run.catch` | n/a | static argument | n/a |
| 7 | `:221` `execSync("git rev-parse HEAD").trim()` | `git(["rev-parse", "HEAD"], repoRoot)` | trimmed, as before | same | n/a | static | n/a |
| 8 | `:222` `execSync("git status --porcelain")` `.split("\n").filter(Boolean)` | `run("git", ["status", "--porcelain"], { cwd: repoRoot }).stdout.split(…)` — deliberately NOT `git()`: trimming would strip the leading space of the first ` M path` line and break the `l.slice(3)` allowlist filter | untrimmed, as before | same | n/a | static | n/a |
| 9 | `:290` `` execSync(`git status --porcelain -- ${JSON.stringify(intentPath)}`).trim() `` (JSON.stringify as pseudo-quoting) | `run("git", ["--literal-pathspecs", "status", "--porcelain", "--", intentPath], { cwd: repoRoot }).stdout.trim()` | trimmed (only emptiness + display matter) | same | n/a | `--literal-pathspecs` + `--`: the path is neither an option nor pathspec magic | n/a |
| 10 | `:302` `execSync("git status --porcelain")` | as row 8 (`run`, untrimmed) | | same | n/a | static | n/a |
| 11 | `:316` `` execSync(`git diff --name-only ${intent.source.commit} HEAD`) `` (unvalidated JSON field) | `COMMIT_SHA` (`/^[0-9a-f]{40}$/`) check → `git(["diff", "--name-only", "--end-of-options", oid, "HEAD", "--"], repoRoot)` | trimmed (paths) | throws on a non-SHA (new, fail-closed) or a git failure | n/a | **added** | n/a |
| 12 | `:483` `execFileSync("bun", [check-fpc-version.ts, "--mode", "require-deployed"], { stdio: "inherit" })` | `run("bun", [same], { stdio: "inherit" })` | inherit | throws `RunError` on non-zero (was: threw) → same `run.catch` | n/a (hard stop, as before) | fixed argv | n/a |
| 13 | `:525` `execFileSync("bun", [verify-deployments.ts, "--config", faucetCandidatePath], { stdio: "inherit" })` | `run("bun", [same], { stdio: "inherit" })` | inherit | same | n/a | fixed argv + an operator path | n/a |
| 14 | `:565` `execFileSync("bun", [verify-deployments.ts], { stdio: "inherit", env: {…, BRIDGE_MANIFEST} })` | `run("bun", [same], { stdio: "inherit", env: { ...process.env, BRIDGE_MANIFEST: bridgeLivePath } })` | inherit + env, as before | same | n/a | fixed argv | n/a |
| 15 | `:579` `execSync("git rev-parse HEAD").trim()` (promotion receipt) | `git(["rev-parse", "HEAD"], repoRoot)` | trimmed | same | n/a | static | n/a |

Also: the CLI dispatcher's local `const run = …` renamed `dispatch` (it shadowed the imported primitive inside the `isMain` block); the `cast()` doc comment no longer names `execFileSync`. Lazy-resolution probe: `delete process.env.CAST_BIN; process.env.PATH = "/usr/bin:/bin"; await import(live-intent.ts)` → "imported without cast; signer = 0xFcc2…" (no resolution at import). Gate: typecheck clean · 237 passed · biome clean.

## restore-swap.ts (commit 4)

| # | site (old) | new call | options | exit path | soft-fail | validation | lazy |
|---|---|---|---|---|---|---|---|
| 16 | `:97` `` execSync(`git show ${fromRef}:apps/faucet/public/testnet-bridge.json`) `` — `fromRef` straight from `--from` argv, interpolated into a shell string | `git(["rev-parse", "--verify", "--end-of-options", `${fromRef}^{commit}`], repoRoot)` → OID → `git(["show", "--end-of-options", `${oid}:apps/faucet/public/testnet-bridge.json`], repoRoot)` | cwd repoRoot; trimmed (JSON.parse-neutral) | a bad ref now fails at `rev-parse` (`RunError` → `main().catch` → `console.error` + exit 1, as any other failure) | n/a | **added**: the ref can only name a commit; no shell | n/a |

Gate: typecheck clean · 237 passed · biome clean.

## deploy-bridge-testnet.ts (commit 5) and deploy-bridge-mainnet.ts (commit 6)

| # | site (old) | new call | options | exit path | soft-fail | validation | lazy |
|---|---|---|---|---|---|---|---|
| 17 | testnet `:540` `spawnSync("bun", [verify-l1.ts, "--config", CANDIDATE_PATH], { stdio: "inherit" })`; `if (v.status !== 0) console.log("⚠ verification failed …")` | `run("bun", [same], { stdio: "inherit", check: false })`; `if (v.exitCode !== 0) …` | inherit | unchanged: the conductor logs ⚠ and continues; its own exit code stays 0 (gated on `ETHERSCAN_API_KEY`) | **preserved verbatim** (plan Q3 / owner follow-up A4) | fixed argv + the internally built candidate path | n/a |
| 18 | mainnet `:509-510` — identical shape | identical | | | **preserved verbatim** | | |

The indirect sites (`deploy-bridge-{testnet:139,mainnet:153}` → `rebuildAndVerifyPortal()` → `buildForkInL1Root()`, and `build-portal-artifact.ts:21`) inherit row 2's primitive with no edit.

Gate: typecheck clean · 237 passed · biome clean (two pre-existing `info` diagnostics on an untouched line of `deploy-bridge-testnet.ts:207`).

## End of phase

- `rg -n 'node:child_process|execSync|execFileSync|spawnSync' packages/bridge-core/scripts/*.ts` → only `run.ts` (its import, the primitive's call, and one comment). The test file's earlier wording ("…an argument spawnSync rejects…", a test name + comment) was reworded so the check reads exactly as the criterion states; no call exists outside `run.ts`.
- `verify:l1 --dry-run` (testnet) and `--config apps/faucet/public/mainnet-bridge.json --dry-run` at the final state: byte-identical to the Phase 0 baselines (4 ✓; skip + 3 ✓), exit 0.
- 18 rows above ↔ the 18 sites in `recon.md`; the four file-scoped helpers: `forgeBin()` ×2 → one (portal-artifact, lazy), `cast()` → `run(castBin(), …)`, `runForge()`/`buildForkInL1Root()` kept as domain helpers.

LESSONS_FILE=implementations-plan/archive/bun-native-tooling/lessons/phase-1.md
