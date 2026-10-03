# Phase 3: canaries and close

Every canary ran against the promoted `apps/tools/public/testnet-bridge.json`, with
`live-intent verify` ahead of each broadcast group.

## Read-only

- `verify:l1 --strict`: "✓ L1 verification passed", four tokens.
- `verify:deployments` with `BRIDGE_MANIFEST=public/testnet-bridge.json` and without: "All committed
  addresses match the rebuilt instances."
- `check-fpc-version --mode require-deployed`: "✓ FPC gate green (require-deployed) — compat +
  identity + digest + live class all agree."

## Live

- `fuel-testnet`, USDC, `PRIVATE_RUNS=1`, 1.5-token slice: "✅ 2 fueled runs SETTLED in 1.8m". Public
  `claim` 2780770249769800000 FJ-wei; private-FPC `claim` 1909486907084400000, `getFeeLimit`
  4.77 FJ.
- `fee-juice-canary-testnet`: "✅ DIRECT Fee-Juice SELF-PAY canary PASSED — mint→deposit(minFj)→
  self-pay-claim landed 14616575831197400000 FJ-wei (fee 1383424168802600000) in 0.8m." The first
  claim attempt found no L1→L2 message yet and retried.
- `drip-canary-testnet`: "✅ DRIP canary PASSED — SIGNAL + NOISE dripped to a fresh account in 0.5m."
- `TOKEN_LIST_LIVE=1` on `src/token-list.test.ts`: 15 passed.

## Final verify and spend

- "✓ verify green — rollupVersion 2914217885, spend 0.019940/2 ETH".

| Group | Balance after (ETH) | Spent so far (ETH) |
|---|---|---|
| baseline (`build`) | 2.969826697782355 | 0 |
| generation | 2.958030062136801 | 0.0118 |
| pre-creates, including GBPC's reverted attempt | 2.956982809921191 | 0.0128 |
| candidate smokes and first claims | 2.951319072076392 | 0.0185 |
| canaries | 2.949886377970556 | 0.0199 |

The spend reconciles with the 2.0 ETH cap; no WETH was seeded.

## Follow-ups closed

- **Comments in deployed contract sources.** The router compiled from the reworded interface is live;
  `TestUsdc.sol` and `MockSwapTarget.sol` have no deployment on this network.
- **The private first claim** ran (Phase 2): `register_token` plus the claim through the PrivateFPC
  settled with a 14.88 FJ ceiling under the 29.77 FJ floor. The floor stays provisional; its full
  calibration is a follow-up of its own.
