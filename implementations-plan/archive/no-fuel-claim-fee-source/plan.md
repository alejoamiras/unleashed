## Outcome

Archived. Seeds retired.

# No-fuel claim fee source — pay from public OR private Fee Juice

**Tier:** `/blueprint light` · **Status:** COMPLETE · **Scope:** faucet no-fuel bridge claim (+ its bridge-core fee-payment primitives) · **Network:** testnet only.

> ## ⚠️ Post-completion simplification (user-directed) — supersedes the "private-first deterministic" design below
>
> After live testing, the user asked to **NOT pre-select private FJ**: the faucet should just **unblock** the no-fuel claim when there is gas in EITHER balance and let the **wallet's own fee picker** select the method (Public OR Private Fee Juice, or Sponsored) — exactly how the public path always worked. So the faucet **no longer supplies `privateFeeJuicePayment`** and the whole **codex-C estimate/cache machinery is removed**. Net effect:
> - `decideNoFuelFeeSource` (private/public/none/unverifiable + `maxGasCost`) → **`decideNoFuelClaimGate`** (`"allow" | "none" | "unverifiable"`, no gas-cost math): unblock if either balance has gas (`> 0`), fail-closed on unread, `none` if both known-zero.
> - The no-fuel branch sets `fee = undefined` on `allow` (wallet picks); the shared simulate/send reverted to the simple form (no `exactNoFuelFee` cache, no `includeMetadata`).
> - Removed: `NO_FUEL_CLAIM_GAS_BOUND`, the `maxGasCostFor` re-export (+ its test), the `fee`-side `gasSettings`/cache. Kept: `readPrivateFeeJuiceBalance`, the fail-closed reads, the manifest `balance_of` + **`pay_fee`** scopes (the WALLET still calls `pay_fee` when the user picks Private Fee Juice on a faucet tx — so the scope is still required), `privateFeeJuicePayment` in bridge-core (used by the `fuel-testnet.ts` proof), `private-fpc-artifact`.
> - **A1 (no-refund) is now moot as a forced cost**: the user chooses the method in the wallet (can pick Sponsored/free), so the no-refund overpay is only incurred if THEY pick Private Fee Juice.
> - **The estimate-timing fork (codex C) no longer applies** — there is no faucet-committed fee to size. Gates after the change: faucet typecheck 0 · **345 tests** · bridge-core **115** · lint 0.
>
> The original design (private-first deterministic supply + codex-C cache) is preserved below as the historical record of the reasoning; the shipped behavior is the simpler gate above.

## Summary

The private fueled bridge now works: a from-scratch wallet bridges + fuels privately and the claim self-pays on V5 (proven 3× via `fuel-testnet.ts` and once live in the UI). That claim credits the Fee-Juice remainder as a **private** balance held at the Wonderland PrivateFPC (read via `PrivateFPC.balance_of`, shown as "private FJ" in the wallet).

But you can't yet **spend** that earned private gas on a later **no-fuel** bridge (the "arrive with gas" toggle OFF). The faucet's no-fuel path blocks on a **public-FJ-only** pre-flight cold-check (`useDeposit.ts:393` `readPublicFeeJuiceBalance === 0n`) **before the wallet ever opens** — so the user never reaches the wallet's fee picker, which *already* supports paying from private FJ (it offers "Private Fee Juice").

**The fix (corrected after codex round-1):**
- **Private FJ covers the claim → the faucet deterministically supplies `FPCFeePaymentMethod` + explicit, binding gas settings** (feePayer = FPC → the wallet's embedded path; mirrors the existing private fuel claim's fee-settings shape). This is the controllable, self-pay-consistent, private-first path.
- **Else public FJ covers → unblock and defer to the wallet's fee picker** (the wallet has **no** dApp-supplied "pay from my public FJ" discriminator — only `"fjwc"|"fpc"`; the wallet's tested picker owns public-FJ / sponsored selection).
- **Else → block**, distinguishing "no balance in either" (clear shortfall message) from "couldn't read a balance" (**fail-closed**: retry message, never a false "no gas").

## Current behavior (the gap)

- `useDeposit.ts:386–405` — no-fuel branch: `fee = undefined`, and the cold-check **stops** the claim iff `readPublicFeeJuiceBalance === 0n`. Private FJ is never read; a private-FJ-only account is wrongly blocked before reaching the wallet.
- `useDeposit.ts:520` — the standalone no-fuel path has the same public-only gate.
- `capabilities.ts buildCombinedManifest` — scopes `PrivateFPC.mint_and_pay_fee` + `FeeJuice.balance_of_public`, but **not** `PrivateFPC.balance_of` (read private FJ) nor `PrivateFPC.pay_fee` (so the wallet can't execute *any* private-FJ payment — faucet-supplied OR user-picked — under the faucet's app grant).

## Goal & success criteria

A no-fuel bridge claim is **not** blocked when the account holds enough Fee Juice in **either** balance, and it pays from that balance on V5:

1. **Private FJ ≥ reserved cost** → the claim is sent with `FPCFeePaymentMethod(privateFpcAddr)` (private-first, deterministic), committing exact gasLimits learned on the journal's first successful post-sync simulate (codex C — see I3).
2. **Private insufficient, public FJ ≥ reserved cost** → the claim is **unblocked + wallet-chosen** — i.e. the wallet's fee picker handles payment (user selects Public Fee Juice; the wallet owns the gas settings). This is explicitly **NOT** "guaranteed public self-pay" (codex round-2 condition 2): the wallet exposes no dApp-supplied public-FJ method, so the faucet only stops blocking and lets the wallet decide. The default in that picker is Sponsored unless the user picks Public Fee Juice (or has a saved preference).
3. **A required balance read fails** → blocked with a **retry** message (fail-closed), never a false "no gas".
4. **Both known-zero / neither covers** → blocked with a message naming both balances + the shortfall.
5. The source decision is a **pure, unit-tested** function (mirrors `decideFuelClaim`), with explicit `bigint | null` inputs (null = unreadable).
6. **Live proof:** a `fuel-testnet.ts` variant shows earned private FJ paying a subsequent tx via `pay_fee` end-to-end on V5 (the primitive); the faucet→wallet wiring is covered by the user's manual UI run, with an automated dApp-supplied-`FPCFeePaymentMethod` settlement e2e documented as a follow-up (needs an FPC-balance fixture; see Phase 3).

## Scope

**In scope**
- `packages/faucet` — the no-fuel fee-source selection (`useDeposit.ts` both gates), the manifest scope additions (`capabilities.ts`), a fail-closed private-FJ reader, the pure decision function + unit tests.
- `packages/bridge-core` — the fee-payment **primitive** the faucet consumes: a `privateFeeJuicePayment` wrapper (`FPCFeePaymentMethod`) + `PrivateFPCContractArtifact` / `maxGasCostFor` re-exports, beside the existing `privateMintAndPayFee` / `predictedWorstMinFees` / `publicFeeJuicePayment`. **bridge-core already owns every Wonderland fee-payment wrapper — this is the faucet flow's home, not the wallet's general send path.**
- `packages/bridge-core/scripts/fuel-testnet.ts` — a no-fuel-spend variant (live primitive proof).

**Out of scope (explicit)**
- **The wallet's general send** paying arbitrary txs from private FJ via a *faucet-style* supplied method — the wallet already has its own picker path; we don't touch it.
- A faucet-supplied **public-FJ** payment method (the wallet exposes no such dApp discriminator; public defers to the wallet's picker by design).
- The fuel (gas-follows-token) claim path, `minFuelFj` calibration, the wallet change behind `private-fuel-fee-fix`. Untouched.

## Assumptions

### Facts (verified)
1. `FPCFeePaymentMethod(fpcAddress)` (`@wonderland/aztec-fee-payment`, `fee-payment-methods/shared.d.ts`): implements `FeePaymentMethod`, `getFeePayer()` → the FPC, "Deducts max gas cost from the sender's internal balance. **Does not refund unused gas.**"
2. `maxGasCostFor(gasSettings)` (`@wonderland/aztec-fee-payment` utils) = `gasLimits · maxFeesPerGas`, the quantity `pay_fee` asserts against — **but it equals the claim's actual reserved cost ONLY if the same `gasSettings` are committed on send** (see Fact 9; the private branch enforces this by passing them explicitly).
3. `PrivateFPCContractArtifact` is exported from the package index, so bridge-core can build a `balance_of` read.
4. The no-fuel branches gate only on public FJ: `useDeposit.ts:393` + `:520` (`readPublicFeeJuiceBalance === 0n`); `:404` `fee = undefined`.
5. `buildCombinedManifest` (`capabilities.ts:208–290`) scopes `PrivateFPC.mint_and_pay_fee` (`:258`,`:273`) + `FeeJuice.balance_of_public` (`:260`) but **not** `PrivateFPC.balance_of` or `PrivateFPC.pay_fee`.
6. The PrivateFPC stays OUT of manifest `contracts` (auto-registered by the wallet); only its *calls* are scoped — the `mint_and_pay_fee` precedent shows a call to the auto-registered FPC works without `contracts` membership.
7. bridge-core's Wonderland coupling lives in `packages/bridge-core/src/private-fuel.ts`; `fuel-testnet.ts:211` `runVariant(isPrivate, nonce, fuelViaPrivateFpc)` parametrizes the private-FPC path; re-prices per attempt (`buildClaimFee()`, `:269`).
8. The wallet reads private FJ via `PrivateFPC.balance_of`.
9. **(verified, artifact `private_contract-PrivateFPC.json`)** `PrivateFPC.balance_of(account)` is `is_unconstrained: true` / `abi_utility` → `#[external("utility")]` → **`simulation.utilities.scope`** (like the token `balance_of_private` at `capabilities.ts:230–233`). `PrivateFPC.pay_fee(inputs)` is `abi_private` — identical class to the already-dual-scoped `mint_and_pay_fee` → **`simulation.transactions.scope` + `transaction.scope`**.
10. **(verified)** `FPCFeePaymentMethod` emits exactly one private setup call (`pay_fee`); no extra `exec.calls` entry needs scoping (codex confirmed; recursive-subtract is an internal self-call). It crosses the faucet → wallet RPC as an `ExecutionPayload` with `feePayer = FPC`, exactly like the working `PrivateMintAndPayFeePaymentMethod`; the wallet classifies "embedded FPC" by `feePayer !== from`.
11. **(verified)** The wallet's embedded-FPC cap reuses a **supplied** `maxFeesPerGas` and only falls back to `getCurrentMinFees()` when none is supplied; finalization reuses the committed cap for embedded payments. ⇒ supplying explicit gas settings makes the gate binding.
12. **(verified)** The wallet's dApp-supplied fee surface has discriminators `"fjwc" | "fpc"` only; there is **no** "pay from existing public FJ" dApp method. Public-FJ self-pay is the wallet picker's job, shown for no-`feePayer` dApp sends.

### Inferences (unverified — attack these)
- **I3 (resolved → codex C, see lessons/phase-2.md).** The fee path is TWO-stage, because the claim simulate reverts until PXE-sync (`capabilities.ts:235`) and the fee is built before that:
  1. **Conservative pre-flight gate** (fee-build time, no simulate): `maxGasCostFor(predictedWorstMinFees×1.5, NO_FUEL_CLAIM_GAS_BOUND)` sizes ONLY the SOURCE decision (private/public/none/unverifiable). State-aware (live `maxFeesPerGas`); never under-budgets the source choice.
  2. **Exact pricing on send**: the private tentative fee uses the proven fuel-claim shape (float gasLimits) for the simulate; the journal's first successful (post-sync) simulate yields `gasUsed`, cached as exact padded gasLimits and committed on send — so the no-refund `pay_fee` reserves a tight amount, not the network's per-tx admission max (`interaction_options.d.ts:174`). Opportunistic: falls back to the tentative shape if `gasUsed` doesn't cross the dApp simulate boundary. Validated by the live Phase-3 proof. *(This replaces the rejected `minFuelFj/FUEL_FEE_MARGIN` static reference AND the round-2 "build-time binding gate," which the PXE-sync timing made infeasible.)*

### Asks (surfaced — none silent)
- **A1 (confirm at gate).** Private-first means **no gas refund**: `FPCFeePaymentMethod` doesn't refund unused gas, so each private-paid no-fuel claim costs the **full reserved `max_gas_cost`** (≈ `1.5 × actual`, the inclusion-safety pad, with no change returned). Public FJ would refund — but the faucet can't deterministically force public self-pay (Fact 12), so the trade is really "deterministic private self-pay (overpay, private)" vs "defer to the wallet picker (you choose, may pick sponsored)". You chose private-first; this confirms the cost. Flip to "always defer to the wallet picker" if you'd rather choose per-claim.

## Security & Adversarial Considerations

- **New spend authority (codex-flagged, accepted + mitigated).** Adding `PrivateFPC.pay_fee` to the faucet's `transaction.scope` grants the faucet origin the ability to spend the user's private FJ. Combined with no-refunds, a compromised/XSS'd faucet frontend could attempt to drain private FJ via reverting embedded-fee txs. **Mitigations:** (a) every claim is an `aztec_sendTx` the user **approves in the wallet** (the execute window shows the tx + fee payer) — no silent spend; (b) the scope is two **named** functions on the **pinned** `PRIVATE_FPC_L2` address, no wildcard; (c) the **binding, fail-closed** pre-flight gate minimizes reverting-tx attempts; (d) **testnet only**. Residual risk documented; acceptable for testnet, re-evaluate before any mainnet exposure (→ `/harden security` candidate then).
- **Least privilege.** `balance_of` is simulation-only (read). `pay_fee` is the minimum needed for the feature. FPC stays out of `contracts`.
- **Input validation / fail-closed.** Balances are `bigint | null` (null = read threw). A failed read never fabricates spendable balance NOR a false "no gas" — it yields a distinct "couldn't verify, retry" stop. Comparison is `>=` on bigints.
- **Privacy.** Paying via the FPC makes the fee payer the FPC, not a public-balance debit — strictly more private. The FPC already knows the user's internal balance (it minted it); no new leak.
- **Smart-contract risks (Aztec).** Replay/reorg of the claim unchanged (leaf-index-bound message consumption); the fee source doesn't alter it. No new front-running surface (user's own tx).
- **Supply chain.** No new deps — all exports of the already-pinned `@wonderland/aztec-fee-payment`.

## Phases

### Phase 1 — bridge-core fee-payment primitive ✓

**Done.** `privateFeeJuicePayment` + `maxGasCostFor` re-export (`fee-juice.ts`) + `PrivateFPCContractArtifact` re-export (isolated `artifacts.ts` entry, code-split) + 2 unit tests (single `pay_fee` call pin; `maxGasCostFor` arg-order pin). Gate green: typecheck clean · bridge-core 116 tests pass · `bun run lint` exit 0 (my files clean). `LESSONS_FILE=implementations-plan/archive/no-fuel-claim-fee-source/lessons/phase-1.md`

In `packages/bridge-core/src/private-fuel.ts` (beside `privateMintAndPayFee`):
- `privateFeeJuicePayment(fpcAddress: AztecAddress): FPCFeePaymentMethod` — wrapper `new FPCFeePaymentMethod(fpcAddress)`; TSDoc states the **no-refund** property.
- Re-export `PrivateFPCContractArtifact` + `maxGasCostFor` so the faucet builds the `balance_of` read + the binding gate without importing `@wonderland/*` directly (coupling stays in bridge-core).

Unit tests (`private-fuel.test.ts`): `privateFeeJuicePayment(addr).getFeePayer()` resolves to `addr`; re-exports defined. (Thin — the heavy proof is Phase 3.)

**Validation gate**
- Commands: `bun run --cwd packages/bridge-core typecheck && bun run --cwd packages/bridge-core test && bun run lint`
- Pass: typecheck exit 0; bridge-core vitest green (incl. new cases); biome exit 0.
- Layers: typecheck · lint · unit.

### Phase 2 — faucet no-fuel fee-source selection ✓

**Done.** `decideNoFuelFeeSource` (private-first / public-defer / fail-closed) + the fail-closed private-FJ reader (lazy `@unleashed/bridge-core/private-fpc-artifact`) + the binding-via-cache wiring (codex C) + manifest `balance_of`/`pay_fee` + both no-fuel cold-checks now consider private FJ. **Estimate-timing fork resolved by codex C** (conservative pre-flight source gate; exact gasLimits learned on the journal's first successful post-sync simulate, committed on send — NOT a build-time "binding gate"; see lessons/phase-2.md). Gate green: faucet typecheck clean · 347 tests (+10) · bridge-core 116 · `bun run lint` exit 0. `LESSONS_FILE=implementations-plan/archive/no-fuel-claim-fee-source/lessons/phase-2.md`

1. **Pure decision function** — `decideNoFuelFeeSource` in `packages/faucet/src/lib/fuel-claim-state.ts`:
   ```
   decideNoFuelFeeSource({ publicFeeJuice, privateFeeJuice, maxGasCost }:
     { publicFeeJuice: bigint | null; privateFeeJuice: bigint | null; maxGasCost: bigint })
     → { source: "private" } | { source: "public" } | { source: "unverifiable" } | { source: "none"; shortfall: bigint }
   ```
   private-first: `privateFeeJuice != null && privateFeeJuice >= maxGasCost` → `private`; else `publicFeeJuice != null && publicFeeJuice >= maxGasCost` → `public`; else if either input is `null` (a read failed and no known balance covers) → `unverifiable` (**fail-closed**); else `none` with `shortfall = maxGasCost - max(publicFeeJuice ?? 0, privateFeeJuice ?? 0)`.
2. **Fail-closed private-FJ reader** — `readPrivateFeeJuiceBalance(aztec, recipient): Promise<bigint>` in `useDeposit.ts` mirroring `readPublicFeeJuiceBalance`, using `PrivateFPCContractArtifact` + `PRIVATE_FPC_ADDRESS` (via bridge-core) + `readBalance` → `balance_of`. The **caller** maps a throw to `null` (not `0n`) so the decision can fail closed; `readPublicFeeJuiceBalance` callers do the same at these sites.
3. **Binding gas estimate (codex round-2 condition 1)** — simulate the **private-candidate** claim **with `privateFeeJuicePayment(fpcAddr)` attached** and `includeMetadata: true` (mirroring the existing private-claim shape at `useDeposit.ts:303–313`), so `gasUsed` includes the **`PrivateFPC.pay_fee` setup-call overhead** — a *bare* claim simulate under-budgets (the wallet adds FPC gas overhead explicitly). From that: `gasLimits` = `gasUsed` + padding; `maxFeesPerGas = (await predictedWorstMinFees(node)).mul(1.5)`; `teardownGasLimits = 0` → `gasSettings`; `maxGasCost = maxGasCostFor(gasSettings)`. This single (FPC-attached) estimate is the **binding** bound for the private branch (committed verbatim on send) and a **conservative** gate heuristic for the public branch (the wallet re-estimates there; an over-estimate never under-gates).
4. **Wire both no-fuel branches** (`useDeposit.ts:386–405` and `:520`): read both balances (→ `bigint | null`), compute `maxGasCost`, call `decideNoFuelFeeSource`:
   - `private` → `fee = { paymentMethod: privateFeeJuicePayment(privateFpcAddr), gasSettings }` (the **same** `gasSettings` the gate used → binding per Fact 11).
   - `public` → `fee = undefined` (defer to the wallet picker; Fact 12). Unblock.
   - `unverifiable` → `stop("Couldn't check your Fee Juice balance — please try again.")`.
   - `none` → `stop("No Fee Juice to claim this no-fuel bridge (public <X>, private <Y>; need ~<Z>). Enable 'arrive with gas', or fund your account.")`.
5. **Manifest** (`capabilities.ts buildCombinedManifest`): add `{ contract: PRIVATE_FPC_L2, function: "balance_of" }` to **`simulation.utilities.scope`** (Fact 9) and `{ contract: PRIVATE_FPC_L2, function: "pay_fee" }` to BOTH `simulation.transactions.scope` and `transaction.scope` (Fact 9). Update the scoping comment block. **Add `capabilities.test.ts` assertions** that both entries are present in the correct buckets.

Unit tests (`fuel-claim-state.test.ts`, ≥7): `decideNoFuelFeeSource` — private-only→private; public-only→public; both-cover→private; exact-boundary (`balance === maxGasCost`→covers); neither→none+shortfall; private-read-null + public-covers→public; private-read-null + public-zero→unverifiable; both-null→unverifiable.

**Validation gate**
- Commands: `bun run --cwd packages/faucet typecheck && bun run --cwd packages/faucet test && bun run lint`
- Pass: `vue-tsc --noEmit` exit 0; faucet vitest green incl. the new `decideNoFuelFeeSource` (≥7) + `capabilities.test.ts` manifest cases; biome exit 0.
- Layers: typecheck · lint · unit.

### Phase 3 — live primitive proof + wiring assertion ✓

**Done (proven live on V5).** `fuel-testnet.ts` `NOFUEL_SPEND_RUNS` variant: seeded the PrivateFPC (PUBLIC+FPC-fuel bridge → claim SETTLED 21.3m), read `PrivateFPC.balance_of` = **295.14 FJ**, then a tx self-paid from that EXISTING balance via `privateFeeJuicePayment` (`pay_fee`) → **SETTLED**, FPC **295.14 → 292.84 FJ (spent 2.29 FJ)**. `OK NO-FUEL-SPEND run 1` (exit 0, 21.7m). Proves the read + the `pay_fee` spend primitive the faucet's no-fuel claim relies on. Wiring e2e = documented follow-up (item 2). `LESSONS_FILE=implementations-plan/archive/no-fuel-claim-fee-source/lessons/phase-3.md`

1. **fuel-testnet variant** (env-gated, e.g. `NOFUEL_SPEND_RUNS`): private-FPC fuel claim → `readPrivateFeeJuiceBalance` asserts `B > 0` → a **no-fuel** claim paid via `new FPCFeePaymentMethod(fpcAddr)` + explicit binding gas settings, re-priced per attempt → asserts settlement + `B` decreased. Proves the primitive (earned private FJ pays a no-fuel claim, with repricing, on real V5).
2. **Automated wiring assertion → documented follow-up (justified).** Investigation: a *meaningful* dApp-supplied-`FPCFeePaymentMethod` **settlement** e2e needs the test account's PrivateFPC internal balance PRE-FUNDED (`pay_fee` asserts `balance ≥ cost`) — that fixture belongs to the wallet's network e2e suite. A *non-settlement* version (assert only the embedded fee-set badge) would merely duplicate the wallet's **address-agnostic** routing assertion (`feePayer !== undefined → embedded`), adding no signal. So rather than add a near-duplicate / non-functional skipped test, the dApp-supplied-PrivateFPC-`pay_fee` settlement e2e is a **documented follow-up** for the wallet's suite. Today's wiring proof: the live fuel-testnet primitive (settles `pay_fee` on V5) + the user's manual UI run of the full faucet→wallet private claim. This stays within codex's "skipIf/manual, not hard-gate" guidance — refined for proportionality + to avoid a rotting non-functional test.

**Validation gate**
- Commands: `PRIVATE_KEY=<testnet> NOFUEL_SPEND_RUNS=1 bun run packages/bridge-core/scripts/fuel-testnet.ts` (uses the V5 `AZTEC_NODE_URL` default) — plus the Phase-2 faucet gate green.
- Pass: the variant prints settlement (✅) for a no-fuel claim paid from private FJ + the FPC `balance_of` decreased; no inclusion-reject.
- Layers: typecheck · lint · unit · **e2e-live-network (testnet)**.

## Open questions

- **A1 (no-refund / private-first).** Confirm at the gate. Implemented private-first-deterministic; the alternative is "always defer to the wallet picker" (per-claim choice, may pick sponsored).
- **I3 (binding estimate).** Resolved in Phase 2 via the simulate-derived gas settings committed verbatim; the live Phase-3 proof is the backstop.

## Decision log (light)

- **Private deterministic (faucet-supplied FPC) + public deferred (wallet picker)** — forced by Fact 12 (no dApp public-FJ method) + codex round-1 (a bare `fee=undefined` is non-binding and auto-defaults to sponsored). Honors private-first; doesn't fake a binding public path. *(Rejected: faucet-supplied public-FJ method — doesn't exist in the wallet's surface.)*
- **Binding gate via committed gas settings** (codex round-1) over a static calibrated reference — the gate's `maxGasCost` equals what `pay_fee` asserts only because the same settings are sent (Fact 11). *(Rejected: `minFuelFj/FUEL_FEE_MARGIN` — calibrated for the wrong call, state-blind.)*
- **Fail-closed `bigint | null` reads** (codex round-1) over treating errors as `0n` — a transient read error must not silently downgrade or false-"no gas".
- **Primitives in bridge-core** — single-responsibility; bridge-core owns the Wonderland coupling.
- **Phase-3: primitive proof hard + wiring e2e soft** (partial codex adoption) — an automated dApp-FPC e2e is valuable but lands in the wallet's known-flaky network suite; don't hard-gate a `light` fix on it.

## Audit verdicts (codex, session 019ee70a)

- **Round 1: `reject`** — 3 blockers, all verified against the code: (1) `fee = undefined` auto-defaults to Sponsored, not public self-pay; (2) the gate was non-binding (only `paymentMethod` set, not committed gas settings); (3) read-failure-as-`0n` silently downgrades / false "no gas". Plus: no-refund must be surfaced (not a footnote), manifest needs `capabilities.test.ts` coverage, Phase-3 should add an automated wiring proof.
- **Round 2 (resumed, on the revised plan): `conditional approve`** — conditions, both folded in:
  1. **Gas estimate must simulate WITH the tentative `FPCFeePaymentMethod` attached** (not a bare claim) so `gasUsed` includes the `pay_fee` setup overhead → folded into Phase 2 step 3 + I3.
  2. **Criterion 2 must read "public = unblocked + wallet-chosen," not "guaranteed public self-pay"** → folded into success criterion 2 + the decision log.
  - Codex confirmed: the private-deterministic / public-deferred split resolves blocker 1; the binding gate holds (no wallet override of supplied `gasLimits`/`maxFeesPerGas` for embedded payments); the Phase-3 `skipIf`-not-hard-gate pushback is defensible for a `light` fix; no new blockers beyond condition 1.
- **Implementation consult (resumed, response-2): the estimate-timing fork → verdict `C`.** Condition-1's build-time binding gate was infeasible (the claim simulate reverts until PXE-sync; the fee is built before). Codex C: conservative pre-flight source gate + exact gasLimits learned on the journal's first successful post-sync simulate, committed on send (reject A = duplicate retry loop; B alone = not exact pricing). Folded into I3 + success criterion 1 + Phase 2. Full log: lessons/phase-2.md.
- **Post-impl audit: `no high/critical`.** Codex was attempted 2× (`xhigh`) but STALLED mid-synthesis both times (service-side; the response was never produced) — so it was substituted by a documented self-audit of the same 4 vectors (cache correctness / manifest spend-authority / fail-closed asymmetry / live-coverage gap), plus the `/code-review max` self-review (no bugs). All 4 vectors sound; no code changes required. Open item: re-run codex when the service recovers.
