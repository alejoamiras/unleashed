# Phase 7 — Deploy tooling for mainnet

## 7a — Network-aware verify-l1 + circle-proxy skip ✓ (codex post-impl HIGH-4)

- Chain id now comes from the manifest's self-declared `l1ChainId` (legacy fallback Sepolia);
  explorer links follow it.
- `token.source === "circle-proxy"` skips the token source-verify with an explicit note — official
  Circle USDC is not our contract and must never be verified as `MintableERC20`; its **identity**
  (canonical address + code readback) is pinned in the deploy/reuse path, not the Etherscan gate.
- Our own permissionless-mint token verifies exactly as before (`maxWholePerTx` only read there).

**Gate evidence (dry-run, no API key needed):**
- Live testnet manifest → all four standard-json builds ✓ (MintableERC20, the forked portal,
  SwapBridgeRouter, UniswapFuelSwap).
- Placeholder mainnet manifest → token SKIPPED (circle-proxy note), the forked portal +
  SwapBridgeRouter ✓, UniswapFuelSwap correctly absent (core-only fuel).

## Codex post-impl HIGH fixes rolled into this phase window
- HIGH-1: mainnet capability grant now = combined manifest minus faucet tokens (keeps PrivateFPC +
  private-fuel scopes; matches the unconditional FPC registration). Test pins the mainnet shape.
- HIGH-2: `VITE_AZTEC_NODE_URL` is dev/e2e-only; prod always uses the committed per-target node.
- HIGH-3: `deploy-bridge-testnet` emits `l1ChainId`/`walletChainId` (read from the node, reset-safe)
  + `token.source`; `CandidateManifest` type extended.

## 7b.1 — Forge mainnet L1 bundle + fork rehearsal ✓ (D21, owner steer)

Owner asked "wouldn't foundry scripts be better?" — yes, for the mainnet L1
legs: simulate-before-broadcast, `--resume`, `--verify`, and the anvil fork rehearsal. The TS
conductor keeps the L2 half + manifest (cross-domain interleave); the repo already had
`DeployBridge.s.sol`/`DeployFuelLive.s.sol`, so this extends the existing pattern.

- **`src/InertSwapTarget.sol`** — the mainnet swapTarget: no state/owner/selectors; every call
  reverts (`Inert()`). Fills the router's non-zero witness-bound slot while making the dormant
  `bridgeWithFuel` atomically unusable (DP2/DP8).
- **`script/DeployBridgeMainnet.s.sol`** — deploys stub + `SwapBridgeRouter(PERMIT2, feeJuicePortal,
  stub)`. Pre-flight `require`s (fail the SIMULATION, before broadcast): chainid==1; code at
  canonical Permit2 + Circle USDC; USDC identity (decimals 6 + symbol); portal `UNDERLYING()` ==
  fee asset (env-overridable pair, defaults = live node readback). Post-deploy readbacks:
  router permit2/portal/swapTarget/owner + a staticcall proving the stub reverts.
- **`verify-l1.ts`** — bridge-only manifests now source-verify `InertSwapTarget` at the swapTarget
  (dry-run proven; testnet still verifies UniswapFuelSwap).

**GATE PASSED — anvil mainnet-fork rehearsal (zero real funds):**
`anvil --fork-url ethereum-rpc.publicnode.com` → `forge script DeployBridgeMainnet --broadcast`
(anvil dev key) → ALL pre-flight checks passed against REAL mainnet state (real Circle USDC proxy,
real Permit2, the LIVE Aztec FeeJuicePortal `0xaf73…691c` with `UNDERLYING()` == `0xa27e…62d2`),
stub + router deployed, every readback OK, "ONCHAIN EXECUTION COMPLETE & SUCCESSFUL".
This is the exact Phase-8 L1 bundle, rehearsed. Phase 8 = the same script with the real key +
`--slow --verify` (owner go).

**Live-node facts captured** (read-only `node_getNodeInfo` via the Alpha dRPC):
l1ChainId=1, rollupVersion=4248422647 (⇒ wallet id 4248422646 ✓ matches our pin),
feeJuicePortal `0xaf73dd51d1eb8a079bb097f39c832cdd00ac691c`, feeJuice `0xa27ec0006e59f245217ff08cd52a7e8b169e62d2`,
**nodeVersion 5.1.0** — NOTE: our pinned line is 5.0.1; the FPC compat gate's curated list must gain
a 5.1.0 ruling before mainnet private-fuel deploys (7b.2 / A-check at Phase 8).

**Gotchas:** foundry `lib/` is gitignored external deps — a fresh checkout has none, so
populate it before `forge build`. Solidity enforces EIP-55
checksum casing on address literals — paste solc's suggested casing verbatim. `--private-key` does
NOT feed `vm.envUint("PRIVATE_KEY")` — pass the env var (repo convention).

## 7b.2 — Per-network FPC descriptor + fail-closed signer pin ✓

- `private-fpc-canonical-mainnet.json`: identical FPC identity (derivation is network-independent),
  Alpha pins (1 / 4248422647), **compat list deliberately EMPTY** → the mainnet FPC gate FAILS
  CLOSED until the owner rules on 5.0.1-artifact-vs-5.1.0-node compat (mirrors the 5.0.0 process).
  Unit pin flips when the ruling lands.
- `check-fpc-version` selects the descriptor by the LIVE node's identity — never a flag; no match =
  hard STOP.
- `PLAN_PINNED_L1_SIGNERS` map + `requirePinnedSigner()`: mainnet null (fail-closed) until the owner
  creates the fresh mainnet-only EOA at Phase 8. Testnet consumers unchanged.
- Gates: bridge-core 190 (+1), faucet 517, typecheck 0, lint 0.

## Phase 7 boundary decision (logged per loop protocol)
Everything offline-verifiable is DONE. The remaining items (mainnet conductor's L2 half, full-sequence
fee budget sizing, stable L2 deployer port, Circle-USDC reuse-path pin execution) have their FIRST
meaningful execution in the owner-present Phase 6/8 runs — writing that orchestration with no way to
run any gate here would be plausible-but-unverified code, the exact class this plan's audits exist to
prevent. Declared ✓-to-the-offline-boundary; the operator runbook below is the hand-off.

## Phase 6/8 operator runbook (the owner-present sequence)
**Phase 6 (Sepolia, fake money) — REVISED per the bug-bash loop (r2/r3): intent-FIRST ordering,
swap retirement (D22), recorded swapTarget contract. The exact sequence:**
0. `live-intent.ts build <intent>` **BEFORE any broadcast** (captures the pre-spend balance baseline
   + source/artifact pins — building it later excludes earlier spend from the caps; codex r3 HIGH),
   commit the intent. `verify <intent>` before EACH broadcast group.
1. Deploy TestUsdc (forge create, constructor ("Test USDC","USDC",6,1000)).
2. `TOKEN_CONTRACT=TestUsdc TOKEN_NAME="Test USDC" TOKEN_SYMBOL=USDC TOKEN_DECIMALS=6` +
   `BRIDGE_DEPLOYER_SECRET_TESTNET` set → `deploy-bridge-testnet.ts --reuse-token <addr>
   --allow-token-cutover` → fresh portal + L2 trio; candidate = core-only fuel (swap DROPPED — the
   pools are token-keyed, D22) + chain identity + sourceContract=TestUsdc +
   core.swapTargetContract=UniswapFuelSwap (the carried target, recorded so verify-l1 never guesses).
3. Smokes (all via the app's router path + approve fallback): `smoke-existing-testnet --config
   <candidate>` public, `--private`, `--redirect-proof`. (smoke-swap is N/A — no swap stack.)
4. `verify-l1 --config <candidate>` (TestUsdc source + portal + router; carried swapTarget =
   explicit skip note).
5. `live-intent.ts verify <intent> --candidate <candidate>` (records the digest) → **COMMIT the
   digest-bearing intent** (promote requires the digest pre-recorded + tree-clean; codex r3 MED) →
   `live-intent.ts promote <intent> --bridge-only --drop-swap`.
6. Commit + push the promoted manifest; the app rebuild + CF preview pick it up.

**Original env note:**
1. DP7 token: **`TestUsdc.sol` (done, forge 4/4 — 7b.3)** — deploy it (constructor
   `("Test USDC","USDC",6,1000)`), then `deploy-bridge-testnet.ts` with `--reuse-token <it>` → fresh
   portal + L2 trio → candidate (now emits chain identity + source). Wire the conductor's L2 account
   through `resolveDeployerKeys("testnet")` (BRIDGE_DEPLOYER_SECRET_TESTNET in env) replacing the
   two `Fr.random()` at deploy-bridge-testnet.ts:240-242, and size funding via
   `deploySequenceFeeBudget(perTxLimit)` — both landed in 7b.3, wiring is a 5-line change verified
   by the run itself.
2. Gates: `verify-deployments` (BRIDGE_MANIFEST=candidate), `verify-l1 --config candidate`,
   `smoke-swap-existing-testnet --config candidate` (exercises the NEW Permit2 approve fallback —
   the token no longer auto-grants), `fuel-testnet.ts` (public+private, FPC gate inline). Promote.
3. Retire AZLO (D18): heads-up notice; no drain-gate.
**Phase 8 (mainnet, REAL funds — explicit go per tx):**
1. Owner creates the fresh mainnet EOA → pins it in `PLAN_PINNED_L1_SIGNERS.mainnet`; funds ETH +
   $AZTEC. Owner rules on 5.1.0 FPC compat → curates the mainnet descriptor (unit pin flips).
2. L1 bundle: `DeployBridgeMainnet.s.sol` — EXACTLY as fork-rehearsed — `--slow --verify`, with
   FEE_JUICE_PORTAL/FEE_JUICE_ASSET read fresh from the node.
3. The forked portal + L2 trio + PrivateFPC via the conductor against real USDC (`0xA0b8…48`,
   identity-checked), fee juice budgeted for the FULL ~7-tx sequence (fable NEW-2), claim-in-tx
   (`publicFeeJuicePayment`) for the account deploy.
4. Write `mainnet-bridge.json` (circle-proxy, core-only fuel, chain identity 1/4248422646), promote,
   `verify-l1` (mainnet chain — verifies InertSwapTarget), `verify:build-target mainnet`, ship.
5. Phase 9: owner smoke under Access → renounce router owner (verify owner()==0) → revoke BOTH
   Permit2 approvals. Only then public.

## Pool deepening (owner-directed UX fix)

Owner: default 0.25 too small, UI cap 1 token too tight — viable fuel window was [0.75, 1] USDC.

**Probe-first sizing** (`quoteFuelPath` at 1/2/5/10/25 USDC vs a dust quote):
- Before: 0.38%/USDC ≈ linear; 10 USDC = 3.74% (already over the 3% slippage guard), 25 USDC = 8.85%.
- After deepening ONLY token/WETH 6×: 25 USDC still 3.56% → decomposition showed ~2.5% residual lives in
  the ETH/FJ leg. **Lesson: the fuel path has TWO legs; deepening one just moves the bottleneck.**
- After deepening both: 1 USDC 0.09% · 10 USDC 0.86% · 25 USDC 2.12% (live == fork rehearsal, digit-for-digit).

**ETH/FJ drift**: `DeployFuelLive`'s ±10%-sqrt price guard correctly ABORTED the re-seed — live fills had
pushed the pool from the 200K FJ/ETH init target to ~87K. Fix: pass the exact current on-chain sqrtPrice as
`FJ_POOL_SQRT_PRICE` (guard passes trivially) and compute liquidity for the ETH budget at THAT price:
`L = eth / (1/sqrtPc − 1/sqrtPu)` → L=224e18 for 0.6 ETH, ~34.5K FJ (40 free handler mints). Re-seeding at
a stale target price is exactly what the guard exists to prevent — never override it, recompute.

**Broadcasts** (intent caps raised 0.5→2.0 / 0.25→1.5 for this):
1. `SeedTokenPool` WETH_SEED=1.25e18, POOL_LIQUIDITY=3.75e13 — 17/17 txs 0x1 (blocks 11362894–11362911).
2. `DeployFuelLive` seed-only (reused swapTarget+router, SEED_AZLO_WETH=false) — 4/4 txs 0x1.

Spend: 1.8546/2.0 ETH (verify green; balance 8.2568 → 6.4021). No manifest change — fee/tickSpacing
unchanged, liquidity is not manifest state — so NO promote; the live app benefits immediately.

**UI**: MAX_FUEL_SLICE 1 → 25 whole tokens (2.12% at cap < 3% guard), default slice 0.25 → 1 token.
