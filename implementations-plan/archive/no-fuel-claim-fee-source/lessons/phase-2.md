# Phase 2 — faucet no-fuel fee-source selection

## What shipped
- **`fuel-claim-state.ts`** — `decideNoFuelFeeSource({ publicFeeJuice, privateFeeJuice, maxGasCost })` pure fn: private-first, public fallback, `unverifiable` (fail-closed when a read returned `null` and no known balance covers), `none` (both known, neither covers, with shortfall). +8 unit cases.
- **`useDeposit.ts`** —
  - `readPrivateFeeJuiceBalance` (PrivateFPC.balance_of via the lazy `@unleashed/bridge-core/private-fpc-artifact` dynamic import) + `readFeeJuiceOrNull` (maps a read throw → `null`, fail-closed).
  - The no-fuel claim branch: reads both balances, computes a CONSERVATIVE pre-flight cost (`maxGasCostFor(predictedWorstMinFees×1.5, NO_FUEL_CLAIM_GAS_BOUND)`), decides the source, builds the private tentative fee (proven fuel-claim shape) or defers public to the wallet, or stops (unverifiable / none).
  - **codex round-2 C** (the estimate-timing fork, below): the shared simulate caches the EXACT padded gasLimits (`gasUsed.totalGas.mul(1.2)`) from the first successful post-PXE-sync simulate; the send commits `exactNoFuelFee ?? fee`.
  - The pre-deposit cold-check now blocks only a TRULY cold account (zero public AND zero private FJ); a private-read failure gives benefit of the doubt (the claim-time gate is the fail-closed one).
- **`capabilities.ts`** — `buildCombinedManifest`: `PrivateFPC.balance_of` → `simulation.utilities`; `PrivateFPC.pay_fee` → `simulation.transactions` + `transaction` (mirrors `mint_and_pay_fee`). +2 manifest test cases (and updated the exact tx-scope `toEqual` to include `pay_fee`).
- **`useTokenBalance.ts`** — widened `readBalance`'s `fn` union with `"balance_of"` (the PrivateFPC's `abi_utility` read takes the same `executeUtility` path as `balance_of_private`).

## The estimate-timing fork (codex consult, session 019ee70a → response-2)
**Conflict:** codex's plan-condition 1 wanted the gate sized from a claim simulate WITH the FPC payment attached (to include `pay_fee` overhead). But the claim simulate REVERTS until the PXE syncs the bridged message (`capabilities.ts:235-238`), and the fee is built BEFORE that sync — so a dedicated estimate-simulate at fee-build time can't run reliably.

**Codex verdict: C** (reject A, B-only-as-pre-flight):
- Source decision (private/public/none/unverifiable) from a CONSERVATIVE bound at fee-build time (no simulate).
- Private tentative fee = the proven fuel-claim shape (`privateFeeJuicePayment` + `predictedWorstMinFees×1.5` + `teardownGas=0`, float gasLimits) for the SIMULATE.
- The journal already retries that simulate past PXE-sync; on its first success, cache `gasUsed` → exact padded gasLimits.
- The send commits the cached EXACT gasSettings if present, else the tentative shape.
- Condition: describe it as a "conservative pre-flight gate + exact gasLimits learned on the journal's successful simulate, committed on send," NOT a "binding gate." (Plan language updated.)

**Why C matters (SDK doc, `interaction_options.d.ts:174-176`):** if gasLimits are NOT supplied, "the wallet fills in the network's per-tx admission limits automatically" — i.e. potentially loose. With `FPCFeePaymentMethod`'s no-refund, loose gasLimits = real overpay. C derives tight gasLimits from `gasUsed` (the doc's own recommendation), opportunistically (falls back to the tentative shape if `gasUsed` doesn't cross the dApp simulate boundary).

## Gotchas
- **Artifact bundle (revised Phase-1 choice):** `@unleashed/bridge-core/artifacts` is EAGERLY imported by the faucet (tokenBridgeArtifact) → the 2.2 MB PrivateFPC JSON can't live there. Reverted the Phase-1 re-export; added a dedicated dynamic-import-only entry `@unleashed/bridge-core/private-fpc-artifact` (+ exports map). Keeps the Wonderland coupling in bridge-core AND code-split (faucet has no `@wonderland` dep).
- **Edit-tool whitespace/unicode:** the existing file's tabs + em-dashes defeated several `Edit` attempts on the large blocks; used Python line-surgery (content-anchored) for the branch + return-block + pre-deposit rewrites. One mis-target (the `stop` helper's `send:` matched first) was caught + reverted.
- **`fee` type widened** to `{ paymentMethod: unknown; gasSettings?: unknown }` (only `{ paymentMethod }` flowed through before).

## Gate (achieved)
- `bun run --cwd packages/faucet typecheck` → clean.
- `bun run --cwd packages/faucet test` → **347 passed** (30 files; +10: 8 decision-fn + 2 manifest).
- `bun run --cwd packages/bridge-core typecheck` + `test` → clean, **116 passed** (artifacts.ts revert intact).
- `bun run lint` → exit 0 (52 pre-existing repo warnings; none in the changed files).

`LESSONS_FILE=implementations-plan/archive/no-fuel-claim-fee-source/lessons/phase-2.md`

## Phase 2: ✓ (decision fn + readers + binding-via-cache wiring + manifest + both cold-checks; faucet gate green)
