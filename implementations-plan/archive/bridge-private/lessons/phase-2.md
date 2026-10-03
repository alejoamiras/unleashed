# PV2 — private withdraw (lessons)

## codex consult: private-withdraw design (kicked off)
The private burn auth-wit (OFF-chain `createAuthWit` vs the public ON-chain `SetPublicAuthwit`) is the non-trivial part of PV2 — codex'd before writing it (the loop routes non-trivial calls to codex).

Questions sent:
1. Private auth-wit for `burn_private` (`createAuthWit` + how to attach to the exit tx) vs the public `SetPublicAuthwit`.
2. `exit_to_l1_private` args/behavior vs `exit_to_l1_public`.
3. The proving→consume tail — identical to public?
4. Does the private withdraw need a bearer seal? (Believed NO — the exit recipient is L1-bound.)
5. Attacker surface (auth-wit nonce/replay, burn-vs-exit atomicity, consume front-running).

**Verdict (codex `019eac9c`):**
- **CRITICAL** — private authwit is OFF-CHAIN: `wallet.createAuthWit(from, { caller: BRIDGE_PROXY, call: await token.methods.burn_private(from, amount, nonce).getFunctionCall() })` → attach via `bridge.methods.exit_to_l1_private(...).send({ from, fee, wait, authWitnesses: [authwit] })`. Use `call` (getFunctionCall), NOT `action`. NO `SetPublicAuthwit` for private.
- **CRITICAL** — ONE tx: `exit_to_l1_private(recipient, amount, caller_on_l1, nonce)` burns + messages atomically inside the private fn. Never split burn + exit.
- **HIGH** — `caller_on_l1 = ZERO` ⇒ permissionless L1 consume (front-run / grief, NOT theft — recipient+amount are committed). The PUBLIC flow already uses ZERO; keep parity for MVP (only-user-consume = set caller + L1 `withdraw(...,true,...)`, a hardening for BOTH privacies).
- **MEDIUM** — proving→consume tail IDENTICAL to public (same `withdraw(recipient,amount,caller)` content hash) ⇒ reuse `consumeExit` unchanged.
- **MEDIUM** — NO bearer secret (the L2→L1 message binds recipient+amount). No seal for withdraw.
- **MEDIUM** — needs `accounts.canCreateAuthWit` + tx scope for `burn_private` + `exit_to_l1_private` (tx scopes verified in PV4; `canCreateAuthWit` to verify).
- **Looks fine** — replay: fresh `Fr.random()` nonce + `burn_private` is `#[authorize_once]` (one-time, caller-scoped to the bridge proxy).

Implementation: `useWithdraw` `isPrivate` branch (off-chain authwit + `exit_to_l1_private`, ONE tx) + `WithdrawCard` toggle; reuse `consumeExit`; verify `canCreateAuthWit`.

## PV2 IMPLEMENTED (code-complete)
Commits: wire the private withdraw (off-chain `createAuthWit(burn_private)` + `exit_to_l1_private` with `authWitnesses`, ONE tx) + WithdrawCard toggle + test. API verified against `@aztec/wallet-sdk` base_wallet (`createAuthWit(from, CallIntent)`), `CallIntent = { caller, call: FunctionCall }`, `getFunctionCall()`, and the `authWitnesses` send-option. `canCreateAuthWit: true` already in the bridge manifest (capabilities.ts:144,202). 142 faucet tests green.

**NEEDS MANUAL TEST** (real Aztec signature + a private L2 balance): on testnet, select Private → ONE Aztec prompt (`exit_to_l1_private`; the burn authwit is off-chain, no separate prompt) → proven-epoch wait → consume on L1 (one Ethereum prompt). Expected: the PRIVATE L2 balance drops by `amount`; the L1 USDC balance rises by it; a refresh mid-proving resumes the consume.

## Public withdraw structure (reuse — packages/faucet/src/composables/useWithdraw.ts)
`withdraw(amount)`: `SetPublicAuthwit(burn_public)` → `exit_to_l1_public` → persist `{exitTxHash, recipientL1, amount, exitBlock}` → `consumeExit` (proven-epoch wait → L1 outbox consume, with `consumeTxHash` recovery). The consume tail + recovery are flow-agnostic; PV2 changes only the burn auth-wit + the exit call (and likely needs `isPrivate` threaded like `useDeposit`).
