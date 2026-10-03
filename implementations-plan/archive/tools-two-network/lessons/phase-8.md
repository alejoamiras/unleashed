# Phase 8 lessons — mainnet swap-fuel enablement (pre-deploy, no funds spent)

## D23 mainnet leg: discover, never seed

Owner reversed the swap-fuel retirement (D22): fuel ships everywhere. Mainnet's difference from
testnet is WHERE liquidity comes from — testnet seeds its own pools per token generation; mainnet
rides existing canonical Uniswap V4 liquidity, so the pipeline step is DISCOVERY + PROOF, not
seeding.

### Canonical pins (docs.uniswap.org/contracts/v4/deployments, verified on-chain)
- PoolManager `0x000000000004444c5dc75cB358380D2e3dE08A90`, V4Quoter
  `0x52F0E24D1c21C8A0cB1e5a5dD6198556BD9E1203` — code-checked AND re-proven by live quotes.
- Fee asset: portal `0xaf73…691c` UNDERLYING == `$AZTEC 0xA27E…62D2` (symbol AZTEC, 18 dec) ✓.

### Discovery findings (`discover-mainnet-fuel.ts`, read-only)
- **Winner: USDC/WETH 500/10 → native-ETH/AZTEC 10000/200.** 1 USDC → 55.99 AZTEC.
- The 500- and 3000-tier ETH/AZTEC pools are INITIALIZED but quote-dead — slot0 alone proves
  nothing; the quoter dust-probe is the only ground truth. **Lesson: initialized ≠ liquid.**
- NO WETH/AZTEC pool exists — the router's fixed route shape (unwrap → native final hop) is the
  only viable topology, and it works.
- Depth: 25 USDC ≈ 3.02% impact vs 1 USDC (the AZTEC pool is a 1%-fee tier). Phase-8 must
  calibrate mainnet's slippageBps / UI fuel cap to its own curve — do NOT copy testnet's numbers.

### Executing proof (`MainnetFuel.fork.t.sol`, opt-in via ETH_RPC_URL)
Public + private `bridgeWithFuel` executed on a mainnet fork against the canonical pools and the
REAL live FeeJuicePortal — the genuine Aztec Inbox accepted the message (MessageSent, checkpoint
14386). Floors are quoted LIVE in-test (canonical prices move; hardcoded FJ floors would rot).
Circle USDC has no Permit2 auto-allowance — the test mirrors the app's one-time approve.

### Gotcha: forge deterministic deploy addresses carry real mainnet balance on forks
The swap target's "ETH residue" failure (5.77e14 wei) was pre-existing dust AT THE DEPLOY ADDRESS
on live mainnet (verified via cast balance — exact match). Residue assertions on fork tests must be
balance DELTAS from setUp, never absolutes.

### Still owner-gated (Phase 8 proper — REAL money, explicit go per tx)
Pin fresh mainnet EOA (PLAN_PINNED_L1_SIGNERS.mainnet) + fund; FPC compat ruling (DP6); the actual
`DeployBridgeMainnet` broadcast; manifest swap block written from deployed addresses + calibrated
slippageBps/minFuelFj.

## Phase-8 EXECUTION record (owner-authorized through group 4)

Full arc landed in one evening — every broadcast intent-first, journal-first, receipts in
`mainnet-intent.json`. L1: UniswapFuelSwap `0xFe00…7d8c` + SwapBridgeRouter `0x2EB3…7559` +
the forked portal `0x3c32…fab6` (all Etherscan-verified, portal one-shot-initialized against the
PRECOMPUTED bridge address). L2: deployer `0x19ae…d077` bootstrapped CLAIM-IN-TX from 300 bridged
$AZTEC, trio (proxy `0x0681…8784` / token `0x03bd…32b4` / bridge `0x25a4…8807` == the portal-bound
precompute), PrivateFPC at the pinned `0x1a6d…1bc0`. Gates: require-deployed green; dust canary
PASSED (+6.29 FJ private, fee 9.43); public smoke 2.2m; private smoke 3.5m; promote + build-target
verify green. minFuelFj calibrated live: 15.72 FJ (≈0.28 USDC min slice).

Live lessons (all encoded into the scripts/config, not just prose):
- **The Alpha LB fronts a MIXED 5.0.1/5.1.0 fleet** — any single nodeVersion read is one backend's
  answer; compat curation must cover the fleet, and identity pins (chainId/rollupVersion) are the
  stable check, not nodeVersion.
- **Account instances are never served by `node.getContract`** (the later-deployed FPC became
  visible; the account never did). Existence guards for accounts must use serveable state — the
  public fee-juice balance (positive ⇒ the claim-in-tx deploy landed).
- **bridge-core's tsconfig covers only src/** — scripts were never typechecked; two latent crashes
  (removed import, unexported symbol) shipped and surfaced at runtime. Added per-script bundle
  resolution checks during the arc; a scripts-inclusive typecheck lane is follow-up work.
- viem `getContract(...).read.fn` takes args as an ARRAY; bare multi-arg calls crash at runtime
  (caught pre-spend by the journal-first ordering).

## Phase 9 close-out — DP8 executed

Owner smoked the live app.unleashed.systems (CF Access on), then gave the DP8 go:
- `router.renounceOwnership()` — tx 0x93cb61bf508266f6, block 25627050; verified owner()==0x0.
  `setSwapTarget` (and the router's sweep) are permanently dead.
- `USDC.approve(Permit2, 0)` — tx 0xf7ca1a62747c8258, block 25627051; verified allowance 0.
- $AZTEC allowances (FJ portal + Permit2) were already 0 — exact approvals, fully consumed.
- **Deliberate scope call:** the UniswapFuelSwap's owner was KEPT — its only power is `sweep`
  (dust rescue on a contract that nets to zero every fill; no protocol reach). The plan's DP8
  named the router only; killing sweep would only forfeit rescuing users' stray transfers.

The tools-two-network arc is CLOSED. Residual working capital: ~0.0084 ETH on the L1 burner,
~272 FJ public on the L2 deployer (pays future faucet-token maintenance).
