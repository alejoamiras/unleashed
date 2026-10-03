# Phase B-canary — first real testnet deploy (held for promote)

User decision: no separate throwaway — ONE real deploy; if smoke passes it becomes the
B6 promotion candidate; if it fails, triage/fix/redeploy, first clean one wins. Promote stays gated.

Deployer: 0xFcc2…F6F5, 9.66 Sepolia ETH (funded). Writes `testnet-bridge.candidate.json` + a
write-ahead journal into `faucet/public/` — NOT the live file.

## Attempt 1 (FAILED) — `sent.getTxHash is not a function`
Got through: USDC `0xe4ae…4512`, the forked portal `0x3cea…41d5` (drift alarm + reviewed-bytes
load both passed!), L2 account deployed. Died on the first `deployL2` (proxy):
`Contract.deploy(...).send({...})` returns a `DeploySentTx` with NO `getTxHash()` — my two-phase
journal assumed one. **Validated on the real run:** the write-ahead journal (generation salts +
two-phase usdc/portal entries) + the L1 forked-portal deploy from committed reviewed bytes.

## Fixes (committed)
1. `deployL2`: journal the DETERMINISTIC L2 address BEFORE the send (the durable recovery key), then
   `.send({ wait })` for inclusion - the proven pattern from deposit-testnet.ts. No getTxHash.
2. Pre-empted the NEXT bug before it cost a run: aztec.js `.simulate()` returns `{ result }` with a
   shape that varies (deposit-testnet.ts:233 + deploy-sandbox.ts:249/300 cast `as { result }`). My L2
   read-backs did `.toString()` on the wrapper. Made the L2 read-backs BEST-EFFORT (log, never abort)
   - a decode quirk must not false-abort a correct deploy; the deposit->claim smoke is the definitive
   L2 gate and promotion is gated on it. Portal viem read-backs (F-001-critical) stay strict aborts.

Journal archived → `testnet-bridge.journal.failed-1.jsonl`; the orphaned USDC/portal/account on
testnet are abandoned (testnet-cheap). Failure count on the deploy step: **1/5**.

## Attempt 2 — DEPLOY SUCCEEDED
Full stack deployed in 5.1m; the candidate (`testnet-bridge.candidate.json`) was written and ALL
read-backs passed:
- L1: USDC `0x764a…91bb`, the forked portal `0xf2f1…0fa0`.
- L2: proxy `0x0148…8db9` (salt 159662759693), token `0x1a8b…7411` (salt 200911740871),
  bridge `0x2ac1…aa8f` (salt 310287137504); wired + portal initialized.
- Read-backs: portal registry/underlying/l2Bridge ✓; **portal runtime code hash == PIN ✓** (F-001
  reviewed bytes confirmed on-chain); portal.rollup == registry canonical ✓; proxy get_token/get_bridge
  decoded + matched ✓ (best-effort path worked); router.swapTarget (carried-forward) ✓.
- Etherscan: MintableERC20 + **the forked portal** + UniswapFuelSwap + SwapBridgeRouter all verified on
  Sepolia (the forked portal source included).
- Fuel arc carried forward unchanged (router `0x8394…2206`, swapTarget `0xe223…823e`).

The script left the process lingering on open PXE/LMDB handles (no explicit exit(0) after main); killed
it (work done) — the harness reported exit 144 (SIGTERM), not a real failure.

## Plain deposit→claim smoke — PASSED
`smoke-existing-testnet.ts --config <candidate>`: registered the 3 L2 contracts (each address
recomputed ✓) + bridged 100 AZLO L1→L2 in 3.4m. The benign `0xf858ba0c` "function artifact not found"
WARNs are callstack-enrichment noise during the claim retry loop while the L1→L2 message synced.

## Fueled deposit+swap→claim smoke (user request)
- `fuel-testnet.ts --config` already does deposit+swap→claim (public + private, self-paying claim);
  did NOT duplicate it. Wrote a lean candidate-focused sibling `smoke-swap-existing-testnet.ts`
  (committed): register-from-candidate + ONE public fueled bridge + self-paying claim,
  composing the extracted `runSwapBridge`/`publicFeeJuicePayment` flows.
- **Finding:** the candidate deployed a FRESH L1 AZLO (`0x764a…`) with no seeded Uniswap V4 pool
  (verified: "no route through hop 1"). Surfaced the cutover-design choice (reuse the existing L1 AZLO
  vs seed the new one). **User chose: seed a pool for the new AZLO.**
- **Seeded** AZLO/WETH via `DeployFuelLive.s.sol` with `TOKEN_ADDRESS=0x764a…`,
  `FUEL_SWAP_ADDRESS`/`ROUTER_ADDRESS`=carried-forward (reuse, no redeploy), `SEED_ETH_FJ=false` (the
  ETH/FJ tier is token-independent + already seeded). Dry-run + broadcast both SUCCESSFUL (~0.006 ETH
  gas + 0.22 ETH liquidity). The candidate's AZLO sorts below WETH ✓ (currency0 ordering). Route now
  quotes: 0.25 AZLO → ~445 FJ (floor ~432).
### Fueled smoke triage (3 attempts)
- **Attempt 1 FAILED** at `signTypedData`: `Address "undefined"`. My smoke (and fuel-testnet)
  omitted `swapTarget` from the runSwapBridge params (B2 made it a required witness field). Fixed:
  both pass `fuel.swapTarget`.
- **Attempt 2 FAILED** at `bridgeWithFuel`: Permit2 `InvalidSigner` (`0x815e1d64`). The
  witness type strings MATCH in source, so the suspect was the on-chain router. **Verified on-chain:**
  the carried-forward router `0x8394…` is PRE-B2 (`BRIDGE_WITNESS_TYPE_STRING()` lacks swapTarget). So
  F-004 + F-006 were NEVER LIVE - the deploy's "carry forward fuel" shipped the OLD vulnerable router.
  **User chose: redeploy the fuel now.** Deployed fresh UniswapFuelSwap `0x4395…b732` + SwapBridgeRouter
  `0xabc2…d5c0` (DeployFuelLive no-reuse, SEED=false; pools already seeded). Verified the new router's
  witness includes swapTarget + `swapTarget()` is wired. Updated the candidate's `l1.fuel.{router,
  swapTarget}`.
- **Root infra gap:** `scripts/` was never typechecked (bridge-core tsconfig include was src-only),
  which hid BOTH the getTxHash and missing-swapTarget bugs. Fixed: `typecheck` now runs
  `tsconfig.scripts.json` (src + scripts; deploy-sandbox excluded for a pre-existing API-drift error);
  `deploy-bridge-testnet` now ABORTS on a pre-B2 fuel router + accepts `FUEL_ROUTER`/`FUEL_SWAP`.
- **Attempt 3: PASSED** in 4.6m — fueled deposit+swap→self-paying claim. Token balance
  9.75 AZLO (10 − 0.25 fuel slice), FJ gained ~441 (the claim paid its own gas via the bridged Fee
  Juice). Permit2 InvalidSigner gone (new B2 router).

## B-canary DONE — candidate fully validated on testnet
- **Plain deposit→claim** ✓ (100 AZLO).
- **Fueled deposit+swap→self-paying claim** ✓ (9.75 AZLO + ~441 FJ).
- **F-001 live on-chain** ✓ — re-calling `initialize` on the candidate portal `0xf2f1…0fa0` reverts
  with `AlreadyInitialized()` (cast call, decoded).
- **F-004/F-006 live** ✓ — the new B2 router `0xabc2…d5c0` bound swapTarget into the witness (the
  fueled Permit2 sign was accepted).
- **Deploy read-backs** ✓ (portal registry/underlying/l2Bridge + runtime-hash==pin + rollup==canonical).
- On-chain Etherscan-verified: USDC, the forked portal, AND the new fuel UniswapFuelSwap `0x4395…b732` +
  SwapBridgeRouter `0xabc2…d5c0` (verified during the hold, a safe testnet-only B6 prereq). The
  candidate's full L1 surface is verified.

**Candidate addresses (held; promote → testnet-bridge.json at B6):**
- L1: usdc `0x764a…91bb`, portal `0xf2f1…0fa0` (forked-v1), fuel.router `0xabc2…d5c0`,
  fuel.swapTarget `0x4395…b732`.
- L2: proxy `0x0148…8db9`, token `0x1a8b…7411`, bridge `0x2ac1…aa8f`.

STOP — held for the user's explicit promote go (B6 cutover). Live manifest untouched; nothing pushed.
