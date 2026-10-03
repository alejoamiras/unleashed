# Phase 1 — Private-claim feasibility spike (STOP-gate)

**Status:** ✓ STOP-gate PASSED — the carrier-less private claim is constructable + correctly shaped/scoped locally. Proceeding (did NOT trip the stop). Gate green: bridge-core 123 · faucet 336 · typecheck:all exit 0 · lint exit 0.

## What was proven (locally)
- `buildCarrierlessFuelClaimPayload(feeMethod)` = `mergeExecutionPayloads([ExecutionPayload.empty(), await feeMethod.getExecutionPayload()])` → **exactly 2 calls** (`FeeJuice.claim` + `PrivateFPC.mint_and_pay_fee`), **no app call**. The empty app payload contributes nothing — this is the carrier-less shape.
- `feePayer === PRIVATE_FPC_ADDRESS`.
- `feePayer !== claimer` — the exact condition the wallet uses to classify the tx `"fpc"` (the embedded-FPC fee path).
- **Capability scope was already complete.** The faucet uses `buildCombinedManifest` (`useWalletConnection.ts:22`), and `capabilities.test.ts:192-266` ("fuel claim scope") already asserts: `FeeJuice.claim` + `PrivateFPC.mint_and_pay_fee` are scoped for **both send AND simulate** (`:239`), and `PrivateFPC` is kept **OUT of contracts registration** (`:245` — codex's least-privilege requirement). No new faucet test added — that would duplicate existing coverage (testing-philosophy: smallest set, no dupes).

## Decisions / notes
- **No codex consult needed.** The carrier-less model was already decided across the deep blueprint (3 plans + 2 audit rounds + final pass). Phase 1 confirmed the aztec.js 4.2.0 construction is sound: `ExecutionPayload.empty()` + `mergeExecutionPayloads` (both from `@aztec/stdlib/tx`, re-exported by `@aztec/aztec.js/tx`) produce the carrier-less payload; `FeePaymentMethod` type from `@aztec/aztec.js/fee`.
- **The STOP-gate's honest limit (I2).** No local gate can prove the wallet's prover/sequencer accepts a **zero-app-call** tx — there is no sequencer in jsdom. The adjacent precedent `useFaucetDrip.ts:63-67` documents a *related* failure (empty-*setup* tx rejected "Setup function not on allow list"); the carrier-less claim has a *populated, allowlisted* setup but an empty *app* phase, which is the uncharted part. This stays the **dominant deferred risk**, resolved only at live sign-off (plan §5 DQ1, §8 I2). Phase 1 proves construction + scope + classification — NOT acceptance.

## Carry-forward
- Phase 3's private claim builds `new BatchCall(wallet, []).send({ from, fee: { paymentMethod: privateMintAndPayFee(...) }, gasSettings: { teardownGasLimits: 0 } })` with explicit `maxFeesPerGas` (the existing fueled path omits it — codex Round 2), gated by `assertFuelClearsFloor` (fail-closed) + the FPC-drift kill-switch.
- The live sign-off checklist (Phase 5 docs) must gate private-fuel live-trust on the `PRIVATE_FPC_ADDRESS` re-canary for the next-network version (Ask B).
