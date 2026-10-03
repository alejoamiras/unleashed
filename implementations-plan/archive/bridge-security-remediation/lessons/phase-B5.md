# Phase B5 — pre-live LOGIC gate (REVISED: no Aztec sandbox)

## Scope change (user correction)
The user: "there is no sandbox to work with L1<->L2 on Aztec Network, you'll have to deploy to
testnet." So B5's original `deploy-sandbox.ts --smoke` (L2-stack deposit/claim/withdraw) is
INFEASIBLE — the sandbox can't exercise the cross-chain round-trip. That coverage relocates to
B-canary (the throwaway testnet generation is the only faithful L1<->L2 gate). This
supersedes the earlier codex-consult assumption that the sandbox
could provide cross-chain correctness.

B5 therefore stands as the **L1-only EVM logic gate** (local + Sepolia fork). Everything that crosses
L1<->L2 is proven at B-canary on testnet.

## Gate — GREEN
- **Local EVM logic** (`forge test --no-match-path '*[Ff]ork*'`): 29 tests, 0 failed —
  ContentHash (content-hash pins), PortalReinit (F-001 init-once guard reverts on 2nd init),
  WitnessHash (F-004 12-field witness hash pin), RouteValidation (7), SwapBridgeRouter (10), MintableERC20.
- **Sepolia fork** (`SEPOLIA_RPC_URL=… forge test`): SwapBridgeRouterPermit2Fork 5/5 — incl.
  `test_witnessTamperReverts` (the swapTarget binding from B2/F-004) + `test_permit2NonceReplayReverts`
  + `test_permit2ExpiredDeadlineReverts` against REAL Sepolia Permit2; DeployBridge.fork 1/1.
- **l1-contracts-root forge build** of the staged fork: done in B4 (the fork compiles in the l1-root;
  the pinned reviewed-bytes forked portal artifact is committed).
- **NOT run / relocated:**
  - L2 keystone `nargo test` — blocked by an aztec-nr rc.2 toolchain error (723 errors in the library's
    `aztec-nr/.../mock_note.nr`, e.g. "No method 'pack' for MockNote" — NOT our code). Content-hash is
    pinned by the green Solidity `ContentHash.t.sol` and re-proven end-to-end at B-canary. Attempt 1;
    not pursued (clearly a library/toolchain issue, not a remediation regression).
  - `deploy-sandbox --smoke` — infeasible (no L1<->L2 sandbox); → B-canary.
  - DeployFuelLive.fork — not run here (known pre-existing live-Sepolia-pool flake, B2 lesson; not
    security-relevant to the remediation).

## Next: B-canary requires a live testnet deploy
The deployer env IS present (PRIVATE_KEY + SEPOLIA_RPC_URL + ETHERSCAN_API_KEY in
`packages/bridge-core/.env`). B-canary = run the reworked `deploy-bridge-testnet.ts` against testnet
(throwaway generation) → candidate → `smoke-existing-testnet.ts --config` deposit->claim. This is the
FIRST real run of the reworked irreversible deploy script — surfaced to the user for a go before firing
(outward-facing, ~30 min real proving, testnet ETH). B6 (cutover) remains gated on explicit go.

Held local (public repo, PR-B disclosure).
