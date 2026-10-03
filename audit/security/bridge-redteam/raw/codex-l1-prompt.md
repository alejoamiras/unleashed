# Codex red-team: Unleashed bridge — L1 Solidity surface

You are a smart-contract security auditor red-teaming an Aztec L1↔L2 token bridge with an atomic fuel-swap. Goal: find every way an attacker (or a compromised privileged actor missing a safeguard) can **steal user funds, mint free tokens, strand bridged funds, or forge cross-chain messages.** Adversarial mindset; assume hostile users, MEV bots, and front-runners.

## Read first (in the repo)
- `audit/security/bridge-redteam/context.md` — full threat model + 10 grounded hot-spots. ATTACK these; confirm or kill each.
- `audit/security/bridge-redteam/raw/repo-map.md` — flow diagram + trust boundaries.

## Audit these files (read them directly)
- `packages/bridge-evm/src/SwapBridgeRouter.sol` (the crux: Permit2 witness, swap orchestration, approvals, sweep)
- `packages/bridge-evm/src/UniswapFuelSwap.sol` (V4 flash-accounting, route validation, native-ETH settlement)
- `packages/bridge-evm/src/MintableERC20.sol` (allowance override, permissionless mint)
- `packages/bridge-evm/src/mocks/MockSwapTarget.sol` (only re: the router's setSwapTarget→arbitrary-target power)
- `packages/bridge-evm/upstream/TokenPortal.sol` (vendored canonical; audit our WIRING/INIT not OZ internals)
- `packages/bridge-evm/script/DeployBridge.s.sol` and `packages/bridge-core/scripts/deposit-testnet.ts` (deploy/init/minter wiring — does TokenPortal.initialize run atomically + is re-init possible/front-runnable?)

## Vulnerability taxonomy (smart-contract, SWC/CWE where possible)
Reentrancy (single/cross-fn/read-only), access control / privilege, signature replay (cross-chain/cross-contract/nonce), EIP-712 type-string/hash mismatch & type confusion, Permit2 witness completeness (is EVERY fund-affecting param bound?), unprotected/re-init, swap slippage / sandwich / MEV / price manipulation of thin pools, approval residue / fee-on-transfer / rebasing / malicious-ERC20 (`bridgeToken` is arbitrary), balance-check bypass, integer/rounding/overflow, native-ETH handling & stuck funds, DoS/griefing, front-running of deposit/claim, content-hash construction correctness (L1 side), force-feeding, owner-key-compromise blast radius (only if a safeguard is missing).

## For EACH finding return (structured):
1. Title. 2. Impact factors (which CIA+A property, blast radius, funds at risk) + exploitability (vector, complexity, privileges, interaction) — DO NOT assign a CVSS number. 3. Confidence (high/moderate/low). 4. SWC/CWE. 5. Trace: source→sink with `file:line` at each step. 6. Exploit scenario: concrete steps + realistic values. 7. Preconditions. 8. Why existing guards (minFuelOutput/balance/consumed checks, nonReentrant, forceApprove-to-zero) fail to stop it — or, if they DO stop it, say so explicitly (clearing a hot-spot is a valuable result). 9. Fix (smallest safe change). 10. PoC test idea (Foundry `*.t.sol`: setup, the malicious action, the assertion that fails pre-fix).

No concrete trace ⇒ NON-FINDING; do not speculate. Be critical: try to BREAK each hot-spot before validating it. End with a short "hot-spots I could NOT break (and why they're safe)" list. Respond as markdown; keep each finding tight.
