# F6 — Withdraw built; swap deferred (testnet pool blocker)

## Withdraw ✅ (UI + logic; manual end-to-end test pending)
`useWithdraw` (faucet-side, mirrors the sandbox-proven `consumeWithdrawal`): burn auth-wit + `exit_to_l1_public` on L2 (`useBridgeWallet`) → `waitForProven` (1800s budget for the testnet epoch lag, with a live proven-block countdown) → `computeL2ToL1MembershipWitness` → `portal.withdraw` on L1 (`useL1Wallet`, canonical viem; no viem types crossed). `WithdrawCard` (amount + stage bar + blocks-remaining countdown) in `BridgeView` below `DepositCard` — the bridge is bidirectional UI-wise (Playwright snapshot: Deposit + Withdraw cards both render). lint + tsc + 128 tests + build green.

**Manual-test caveat:** the L2→L1 exit needs a PROVEN epoch before the L1 consume; testnet proving lagged badly before (a script withdraw timed out at 30 min, proven block frozen). The withdraw works, but the wait is long + proving-dependent — hence the 1800s budget + the blocks-remaining countdown (the goal's "block-countdown bar", meaningful here vs the deposit's inbox lag).

## Swap — DEFERRED (no V4 pool for the bridge's USDC)
`bridgeWithFuel` routes the bridge's USDC → Fee Juice through Uniswap V4. The bridge's testnet USDC is a freshly-deployed `MintableERC20` with **NO V4 pool / liquidity** on Sepolia. The swap is only validatable against real-token pools — done (the 32-test Sepolia *fork* suite, green in `bridge-evm`). Running it through the app on testnet needs a **seeded V4 pool for the bridge's USDC** (gas + LP + pool init) — a separate effort, deferred pending the user's call (build swap UI + seed a pool, vs keep the swap fork-proven only).
