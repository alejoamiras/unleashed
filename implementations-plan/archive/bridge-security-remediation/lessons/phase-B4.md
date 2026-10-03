# Phase B4 — deploy-script rework (PR B, multi-commit, in progress)

B4 reworks the LIVE-cutover deploy. Decisions routed to codex per the loop directive.

## Codex consult (session 019ecbee-486b-7830-9c0d-60072b704735)
Asked xhigh/read-only to attack the deploy-orchestration design before writing it. Verdict adopted
in full (advisory, but clearly right on the irreversible-cutover safety properties):

1. **Not pure build-at-deploy** → **pinned prebuilt**: a one-shot irreversible cutover wants "exact
   reviewed bytes", not "whatever builds today" (checkout / node_modules / forge / solc / remaps are
   all mutable inputs). Commit the reviewed artifact + pin (source keccak + creation/runtime code
   hash + toolchain), rebuild-and-compare at deploy, abort on mismatch.
2. **Resume binds the WHOLE generation** (portal addr, L2 salts, derived L2 addrs, bytecode hashes,
   tx hashes). Fresh salts after ANY successful `portal.initialize` are FORBIDDEN (once initialized
   the portal is married to that exact L2 bridge). portal-uninitialized → resume recorded generation
   only; portal-initialized → resume only if all read-backs + recomputed addrs match, else HARD STOP
   for manual intervention (never auto-fresh-generation).
3. **Biggest false-confidence trap: journaling too early.** `TxStatus.PROPOSED` is not durable.
   Two-phase journal (`submitted txHash` first, then `confirmed`); record the L1 tx hash/nonce BEFORE
   awaiting the receipt (a crash between submit and receipt must stay provable).
4. **"Write nothing on mismatch" is NOT rollback** — it preserves the OLD manifest (old/vulnerable
   bridge). → the deploy writes a CANDIDATE path, never the live `testnet-bridge.json`; promotion to
   live is the deliberate B6 cutover step.
5. **fsync** the journal after each committed state change + fsync the parent dir after create/rename.
6. **Read-backs incomplete** → add `proxy.get_bridge()`, recompute-from-salts == recorded L2 addrs,
   on-chain runtime-code-hash == pinned (not "code exists"), and rollup/outbox/inbox/rollupVersion
   consistent with `registry.getCanonicalRollup()` (the fork exposes all four getters).

## Sub-step 1 (committed) — pinned reviewed-bytes portal artifact
- **De-risked the whole F-001 deploy**: the fork BUILDS cleanly in the l1-contracts root
  (`node_modules/@aztec/l1-artifacts/l1-contracts`) with forge 1.4.1 + solc 0.8.30. Captured pins:
  source keccak `0x60de…673b`, initCodeHash `0x1fa7…de2e`, runtimeCodeHash `0xe10a…b06f`.
- `scripts/portal-artifact.ts`: the pins + `loadForkedPortalArtifact()` (reads the committed bytes,
  asserts vs pins + current source) + `rebuildAndVerifyPortal()` (deploy drift alarm) + shared
  staging/build helpers (one source of truth for deploy + verify + the regenerator).
- `scripts/build-portal-artifact.ts`: regenerates the forked portal artifact
  (18KB: abi + creation + runtime bytes + pins). Bumping the fork/toolchain is a deliberate event.
- **Gate:** generator runs clean (pins match) + `loadForkedPortalArtifact()` round-trips + bridge-core
  `tsc --noEmit` + biome green.

## Sub-step 2 (committed) — verify the forked portal + `--config`
- `verify-l1.ts` branches on `config.l1.portalSource`: `forked-v1` stages the forked portal into the
  l1-root (self-pinned via `stageForkSource`) + verifies it; legacy/absent keeps the
  canonical TokenPortal path. `verify-l1` + `fuel-testnet` accept `--config <path>` (target a
  candidate manifest, not the live file).
- **Gate:** `verify:l1 --dry-run --config <synthetic forked-v1>` builds standard-json for both
  MintableERC20 (6 sources) + the forked portal (86 sources, real @aztec interfaces resolve) + bridge-core
  `tsc --noEmit` + biome green.

## Sub-step 3a (committed) — write-ahead journal + atomic candidate manifest
- `scripts/deploy-manifest.ts`: `writeCandidateAtomic` (sibling temp 0600 + fsync + rename + parent
  fsync), `appendJournal`/`readJournal` (two-phase, fsync per append + parent), `resolveResume`
  (reconstructs salts + confirmed steps + portal-initialized flag).
- **Gate:** 5 vitest round-trip cases green (candidate read-back of every faucet-consumed field, no
  temp left, journal two-phase, resume reconstruction).

## Sub-step 3b (committed) — deploy reworked for the fork + candidate
- Deploys the forked portal from the committed reviewed bytes (uninitialized) after a
  `rebuildAndVerifyPortal()` drift alarm; per-generation RANDOM salts; two-phase journal; expanded
  read-backs (portal registry/underlying/l2Bridge + runtime-hash==pin + rollup==registry-canonical;
  proxy get_token/get_bridge; bridge config; carried-forward router.swapTarget); writes a CANDIDATE
  (atomic), never the live file; carries `l1.fuel` forward unchanged.
- **Resume divergence from codex (logged):** codex said "auto-resume an uninitialized partial". I made
  it stricter - `--from-journal` validates a FULLY-landed generation and writes the candidate, else
  HARD-STOP. Reason codex's read-only pass couldn't see: the proxy ctor sets `owner = msg_sender`, so
  a resumed run with a fresh L2 account is NOT the owner and can't call `set_token`/`set_bridge`;
  reusing the account would mean persisting its secret (against the hard limit). Hard-stop is strictly
  safer than codex's suggestion, so it exceeds (not conflicts with) the advice.
- **Gate here:** typecheck + lint + the deploy-manifest units. The live run (view-decode shapes,
  SentTx two-phase, init revert-on-2nd) is exercised at B-canary before B6.

## Sub-step 3c (committed) — proxy artifact regen (PREREQUISITE, not follow-on)
- Caught a sequencing bug: both `deploy-bridge-testnet` and `smoke-existing` read
  `token_minter_proxy/target/*.json` at runtime, but git still had the OLD `set_minter` artifact (B3
  discarded its recompile). The L2 address derives from the artifact, so the stale class would
  deploy/register the WRONG contract. Recompiled (`compile.sh`): proxy ABI now
  set_bridge/get_bridge/assert_bridge (no set_minter); the token_bridge artifact's embedded proxy
  storage ref followed (`can_mint` -> `bridge`, one line). Committed both.

## Sub-step 3d (committed) — smoke-existing-testnet
- `scripts/smoke-existing-testnet.ts`: reads a candidate via `--config`, REGISTERS the L1/L2
  contracts (no deploy) asserting each L2 address recomputes from its recorded salt+args (the exact
  reconstruction the faucet's `bridge-deployments.ts` does), then runs a plain deposit→claim. Green =
  the candidate is self-consistent + bridges, so it is safe to promote candidate -> live.

## B4 close-gate — GREEN
- deploy-manifest round-trip units (5) + full bridge-core (17 files / 114) + full faucet (30 / 335)
  all pass; verify-l1 forked dry-run green. The LIVE deploy/smoke runtime (view decode, SentTx
  two-phase, init revert-on-2nd, register+deposit+claim) is exercised at **B-canary** before B6.

**B4 DONE.** Six commits, all held local.

Held local (public repo, PR-B disclosure).
