# Phase 2 — wallet scope + cold-start EXTERNAL payload

Status: **manifest ✓ (faucet code green); the wallet-side network-e2e REMAINS.** Moves no funds.

## Done
- `capabilities.ts` `buildCombinedManifest` (the LIVE manifest): scoped `FeeJuice.claim` +
  `PrivateFPC.mint_and_pay_fee` in BOTH `transaction.scope` and `simulation.transactions.scope`
  (so the private cold-start claim is simulate-gated like the public fjwc one). Function names verified
  against Wonderland `private.js`: `"claim((Field),u128,Field,Field)"` + `"mint_and_pay_fee(u128,Field,Field)"`.
- **Registration decision (refines plan part 2):** the PrivateFPC is NOT added to `contracts`, and the
  faucet does NOT `registerContract` it — mirroring the SponsoredFPC, which the wallet auto-registers
  (it auto-registers BOTH protocol FPCs). This avoids dragging the 2.2 MB artifact into the
  faucet bundle. The network-e2e (remaining) is the arbiter of whether auto-registration suffices for the
  EXTERNAL cold-start sim; if it throws "Function artifact not found", escalate to explicit registration.
- Pins: combined manifest scopes private fuel for send AND simulate; PrivateFPC absent from `contracts`.
  Faucet capabilities suite 21/21.

## ⚠ Lesson: Aztec poseidon at MODULE-LOAD crashes non-node bundles
P0 computed `DOM_SEP = poseidon2HashBytes(...)` at module top-level. Merely IMPORTING `@unleashed/bridge-core`
(for `feeJuiceAddress`) then ran that poseidon at load — which threw `BBApiException: std::bad_cast` in the
faucet's jsdom vitest env (`BarretenbergSync` not yet initialized). `computeSecretHash` (same sync-poseidon
family) works in the faucet because it's CALLED at runtime (post-init), not at import. Fix: pin hash-derived
constants as LITERALS, verify them in a node test (the drift tripwire). Never compute an `@aztec` hash at
TS module-load time in code that a browser/jsdom bundle imports.

## Gas-cap parity ✓ (already covered)
The wallet's gas cap is mode-driven (fpc/fjwc/default), not payload-shape-driven. The private claim is
an `embedded="fpc"` payment (feePayer=FPC≠from), so a dApp's explicit maxFeesPerGas passes through with
the node not consulted — the private-fuel gas behavior — and so does `teardownGasLimits` (L14: explicit
teardownGas=0 survives).

## Network-e2e — DEFERRED (wallet-side, unrunnable here)
The network-e2e (L12/L13/L16) is coupled to the wallet's harness (bridge FJ to the FPC → derive
secret/leafIndex/amount → drive the claim → assert the result) and runs in the wallet's suite
as the tail of P2 — not speculatively now. The manifest scope (the code the e2e will exercise)
is in place. **Remaining (wallet-side): the cold-start private network-e2e + the FUNDED-account no-fuel e2e.**

## Gate (partial)
- `bun run --cwd packages/faucet test capabilities` → 21/21.
- `bun run --cwd packages/bridge-core test` → 107/107 (DOM_SEP literal, no regression).
- `audit:vue` (full faucet build) + the network-e2e are the remaining P2 gates.
