# PV4 — scopes + tests (lessons)

## manifest scopes VERIFIED (codex-independent, done while the PV2 codex consult ran)
`packages/faucet/src/lib/capabilities.ts` already scopes EVERY private bridge method — no changes needed:
- `simulation.utilities.scope`: `balance_of_private` (usdc, eth, token) — lines 91, 153, 213–215.
- `simulation.transactions.scope`: `claim_private`, `exit_to_l1_private`, `burn_private` (+ the public variants + `balance_of_public`) — lines 229–233.
- `transaction.scope`: `claim_private`, `exit_to_l1_private`, `burn_private` (+ public) — lines 245–249.

So the private deposit (`claim_private` + `balance_of_private`) AND the private withdraw (`burn_private` + `exit_to_l1_private`) will NOT hit "Capability simulation/transaction not granted" during the manual test — the combined manifest the faucet requests on connect already covers them.

Remaining PV4: component test(s) for the DepositCard toggle (+ WithdrawCard once PV2 lands); `bun run audit:vue`.
