# Phase 1 — bridge-core private-fuel plumbing

Status: **green.** Moves no funds.

## What shipped
- `private-fuel.ts`: `privateMintAndPayFee(fpc, amount, secret, salt, leafIndex)` wrapping Wonderland's
  `PrivateMintAndPayFeePaymentMethod` — the single Wonderland coupling for the fee method.
- `flows.ts`: `SwapBridgeParams.fuelSecret?: Fr` (injected). `runSwapBridge` now does
  `const fuelSecret = p.fuelSecret ?? Fr.random()` — the PUBLIC path is byte-identical (no injection ⇒
  random, recipient-bound, exactly as before); PRIVATE injects `deriveBridgeSecret(salt, claimer)`.
  `fuelRecipient` was already a caller-set param (caller passes `PRIVATE_FPC_ADDRESS` for private), so
  no other flow change. Salt + fpc persistence is the caller's job (P3 journal).

## Browser-safety confirmed (the P0 open question, partly closed)
`@wonderland/aztec-fee-payment/fee-payment-methods` → `private.js` imports only `@aztec/stdlib/{abi,tx}`,
`@aztec/aztec.js/fields` (Fr), `@aztec/protocol-contracts`. It builds the two `FunctionCall`s manually
via `FunctionSelector` — **no 2.2 MB artifact, no `aztec.js/contracts`, no `document`/`window`**. And the
`@unleashed/bridge-core` package is faucet/script-only, so bridge-core
using aztec.js subpaths is fine (its browser consumer, the faucet page, has a DOM). The remaining
browser-bundle proof is poseidon2 in the faucet build (P3 `audit:vue`).

## Pins (flows.test.ts + private-fuel.test.ts)
- `runSwapBridge` with an injected derived secret → `result.fuelSecretHex === injected` AND the value
  sent on-chain (`writeContract` arg `bridgeParams.fuelSecretHash`) equals `privateFuelSecretHash(salt, claimer)`.
  This proves the injected secret binds the actual L1 witness, not just the return.
- `runSwapBridge` with no injection → random 32-byte secret, distinct from the token secret (PUBLIC unchanged).
- `privateMintAndPayFee` → `getFeePayer() === PRIVATE_FPC_ADDRESS`; `getExecutionPayload().calls` has length 2
  (FeeJuice.claim + mint_and_pay_fee).

Note: the plan's "golden vs l1.test.ts" public-bytes pin is satisfied structurally — only the secret
*source* changed (gated behind `?? Fr.random()`), the witness/bridgeParams construction is untouched.

## Gate result
- `bun run --cwd packages/bridge-core typecheck` → exit 0.
- `bun run --cwd packages/bridge-core test` → 16 files, **107/107** (+3 over P0's 104).
