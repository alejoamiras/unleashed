## Outcome

Archived. Seeds retired.

# Private-fuel claim fee fix (V5 self-paying budget)

**Status:** AWAITING APPROVAL (codex round-1 reject → round-2 conditional approve, all conditions folded) · **Tier:** light (codex suggests `mid` — user's call at the gate) · **Parent:** [fuel-portal-v5-fix](../fuel-portal-v5-fix/plan.md)

> **Deferred follow-up:** the public `fjwc` claim commits a 1.0× fee cap and carries the same latent inclusion-reject risk; not addressed here (no FPC budget gate, and broadening the general cap risks other dApps). Track separately.

## Summary

After the portal fix, the **private** fueled-bridge claim reverts `assert(amount >= max_gas_cost)` inside Wonderland's `PrivateFPC.mint_and_pay_fee`. Three codex agents (`019ee66b-01a4/-05ea/-09e5`) confirmed this is **NOT a Wonderland bug and NOT a 5.0 gas-model break** — the FPC's `max_gas_cost = gasLimits·maxFeesPerGas` exactly matches 5.0's `GasSettings.getFeeLimit()`. Public works because `FeeJuicePaymentMethodWithClaim` is a single cheaper setup call with no upfront budget gate; the private path bundles `claim` + `mint_and_pay_fee` and enforces the ceiling upfront.

### Two DISTINCT risks (codex round-1 reject — the core correction)

The first draft conflated these; they need **different** mitigations:

1. **Budget-fail:** `bridged_FJ < committed getFeeLimit()` (= `gasLimit · committed maxFeesPerGas`). The FPC asserts `amount >= max_gas_cost` upfront. Fixed by: bridged FJ ≥ the committed ceiling (calibrate `minFuelFj`), and/or a smaller committed ceiling.
2. **Inclusion-reject:** `committed maxFeesPerGas < live min fee` at execution time (`transaction_fee.ts` requires committed ≥ live). Fixed **only** by headroom in the committed `maxFeesPerGas` (or repricing/rebuild) — **NOT** by a larger bridged amount. The proving/sync window for a fueled claim is **much longer than the ~2-slot fee-oracle lag** (`@aztec/stdlib/src/gas/README.md`), so a tight `1.0×` cap committed at finalize can be underpriced by inclusion → on-chain reject.

**The corrected design** keeps the objective "smallest **reliable** cap" (not smallest cap):
- Commit `maxFeesPerGas = getCurrentMinFees() × RELIABILITY_MULT` for the private fuel claim (headroom so it survives the proving-window fee drift — resolves inclusion-reject). This is the user's instinct, and it's correct.
- **Pin** that committed value consistently (kill the wallet's post-simulation refetch/overwrite drift) so the FPC budget is reasoned against exactly what's committed.
- Calibrate `minFuelFj` against the **committed ceiling** `gasLimit · (minFees × RELIABILITY_MULT)`, with a further `FUEL_FEE_MARGIN` for the longer bridge→claim drift (resolves budget-fail). The bridged amount must cover the headroom'd ceiling.
- Net cost: the FPC keeps `committed_ceiling − actual_fee` (the user forfeits the unused headroom). `RELIABILITY_MULT` is chosen as the *smallest* value that reliably clears inclusion across the proving window — measured empirically, not guessed.

Three codex agents + this audit (`019ee67b`) all confirm: don't touch Wonderland's FPC (correct), don't pad the *general* embedded cap (other dApps assume 1.0×) — scope the headroom to the **private fuel claim path** (explicit fees from `useDeposit`), and prove it with a real embedded-`feePayer` settlement e2e + repeated live `fuel-testnet` private runs.

## Ground truth (verified — see Assumptions for cites)

- `PrivateFPC.mint_and_pay_fee`: `max_gas_cost = daGas·feePerDaGas + l2Gas·feePerL2Gas`, asserts `amount >= max_gas_cost`; matches 5.0 `getFeeLimit()`. No teardown double-count / unit regression.
- Protocol requires committed `maxFeesPerGas >= live gasFees` at execution (`transaction_fee.ts`); base_wallet normally prices against *predicted* future min fees, not just current (`base_wallet.ts`). Fee updates can activate after ~2 slots; the claim's prove/sync window is far longer.
- The wallet caps an embedded FPC payment's `maxFeesPerGas → getCurrentMinFees()` (1.0×) by design (padding the *general* embedded cap breaks dApps that budget at 1.0×). After simulation it then **refetches+overwrites** that value, because the cap it committed isn't carried over (the drift).
- `fuel-testnet.ts` exercises only `publicFeeJuicePayment`; the private FPC fuel claim is not tested there; it calibrates `minFuelFj = 2× transactionFee` (actual, not ceiling).
- No existing wallet e2e exercises the embedded `feePayer` claim path to settlement (codex). The closest one only asserts popup state, not settlement.

---

## Phases

### Phase 1 — Reliable, pinned fee cap for the embedded fuel claim (wallet-side) — ✓ DONE

**Objective.** The private fuel claim commits a `maxFeesPerGas` that is (a) **high enough to survive inclusion** across the proving window, and (b) **pinned** so the FPC budget is reasoned against exactly what's committed — without changing the *general* embedded 1.0× cap that other dApps rely on.

**Approach.**
- `useDeposit.ts` (private fuel claim) passes an **explicit** `maxFeesPerGas` derived from **`node.getPredictedMinFees()`** — the protocol's worst-case min fee across predicted future slots (what `base_wallet` uses; falls back to `getCurrentMinFees` when unsupported). This is the protocol-informed inclusion headroom (codex round-2 condition 1), NOT a hand-picked multiplier on current min. The wallet honors an explicit `fee.maxFeesPerGas` and commits it with no refetch, scoping the headroom to the fuel claim only.
- The wallet fixes the drift as defense-in-depth: for an embedded fee payment with no explicit `maxFeesPerGas`, it reuses the value it already capped instead of refetching (codex's option (b); explicitly gated on embedded payments so non-embedded paths keep the 1.5× general default).
- An optional small `RELIABILITY_PAD` on top of the predicted worst-case is a Phase-2 empirical decision (default: none — the prediction already bounds the window); the empirical runs VALIDATE the predicted-fee basis, they don't DERIVE the cap.

**Validation gate.**
- Commands: the wallet's own gate.
- Pass criteria: (i) an embedded payment with explicit `maxFeesPerGas` commits exactly that (no refetch/overwrite); (ii) an embedded payment WITHOUT explicit fees reuses the capped value (no drift); (iii) a NON-embedded payment still gets the 1.5× general default.
- Layers: typecheck + lint + unit.

### Phase 2 — Private FPC claim in `fuel-testnet.ts` + empirical calibration — ✓ DONE (3/3 SETTLED · ceiling ~2.5 FJ · minFuelFj 5.085 FJ)

**Objective.** Exercise the private self-paying claim on live V5, **decompose** the ceiling, find `RELIABILITY_MULT` + `minFuelFj` empirically, and prove the claim settles reliably across fee conditions. Run as many times as needed.

**Steps.**
- **NO FPC deploy needed (codex `019ee697` corrected the earlier "must deploy" finding).** The PrivateFPC has no public functions / no init → Aztec 5.0 uses it "without any deployment tx." `node.getContract(0x1fa8746e)==nothing` only means it isn't *published for public execution* — irrelevant to this private path. The only on-chain requirement is the FPC's public FeeJuice balance, which `FeeJuice.claim(fpc, …)` credits — and `mint_and_pay_fee` does that claim as its first setup call. So the claim produces its own settlement state. (Address `0x1fa8746e`, salt 0, 5.0 artifact `fb6f196` — confirmed unchanged from V4.)
- Add a private variant to `fuel-testnet.ts` using `privateMintAndPayFee` (mirror the public block). **Register the FPC locally:** `getContractInstanceFromInstantiationParams(PrivateFPCArtifact, {salt: 0, publicKeys: default, deployer: ZERO})` + `ewallet.registerContract(instance, PrivateFPCArtifact)` (instance + class — the private-kernel oracle needs both; class-only is insufficient).
- For each run, log **separately**: `gasLimit` (da + l2), committed `maxFeesPerGas` (from `getPredictedMinFees`), derived `getFeeLimit = gasLimit·maxFeesPerGas`, the post-inclusion `transactionFee`, AND `getCurrentMinFees()`/`getPredictedMinFees()` at submit vs the committed cap (inclusion-margin). This pins down whether the ceiling is driven by the cap, the drift, or the 2-call `gasLimit` (codex I2).
- **Methodology (codex round-2 condition 1): the committed cap's basis is `getPredictedMinFees` (protocol-informed worst-case), validated empirically — NOT derived from a 3-run sweep.** The ≥3 runs CONFIRM the predicted basis settles across real fee conditions; they don't pick the number. If a run inclusion-rejects, the prediction/pad basis is revisited (e.g. take the worst predicted slot, or add a small pad), not a fitted multiplier.
- Calibrate `minFuelFj = FUEL_FEE_MARGIN × worst committed getFeeLimit` observed under the predicted-fee basis. Confirm stability across runs.

**Validation gate.**
- Commands: `bun run --cwd packages/bridge-core typecheck && bun run --cwd packages/bridge-core test`, then `bun run --cwd packages/bridge-core scripts/fuel-testnet.ts` (≥3 private runs, deployer-funded).
- Pass criteria: bridge-core typecheck + unit green; the **private** self-paying claim SETTLES (included, not just sent) on V5 on every run under the `getPredictedMinFees` cap basis; the per-run log shows gasLimit + maxFeesPerGas + getFeeLimit + actual fee separately; the derived `minFuelFj` is stable and ≥ the worst observed committed ceiling. A single inclusion-reject OR `amount >= max_gas_cost` revert is a hard fail → revisit the predicted-fee basis (worst predicted slot / small pad) and re-run.
- Layers: typecheck + unit + live-network e2e (real private self-paying claim, repeated).

### Phase 3 — Apply calibration + manifest + settlement gate — ✓ DONE (minFuelFj 5.085 FJ promoted live; settlement proven 3× live; CI e2e = follow-up)

**Objective.** Land the calibrated `RELIABILITY_MULT` + `minFuelFj`, then prove no regression with an e2e that actually settles an embedded-`feePayer` tx (the path that regressed).

**Steps.**
- Bake the validated predicted-fee cap basis (+ any small `RELIABILITY_PAD`) into the faucet fee path (Phase-1 site).
- Update both manifests' `l1.fuel.minFuelFj` to the calibrated value (candidate → promote per cutover discipline). Ensure the faucet floor (`useDeposit.ts:267`) + quote gate (`:534`) compare against the ceiling basis. Tighten user-facing copy if the floor moved materially.
- Add an embedded-`feePayer` settlement e2e: a private-fuel network test that sends an embedded-`feePayer` claim **to inclusion** and asserts it settles + the committed `maxFeesPerGas`/`getFeeLimit` is what was intended. Run it (network-e2e).

**Validation gate.**
- Commands: `bun run --cwd packages/faucet typecheck && bun run --cwd packages/faucet test && bun run lint`, then the embedded-`feePayer` settlement e2e (network).
- Pass criteria: faucet typecheck + unit + lint exit 0; the embedded-`feePayer` settlement e2e green (sends + settles, asserts the committed fee cap); a fresh private fueled deposit (via `fuel-testnet.ts` or the UI) self-pays end-to-end against the updated floor.
- Layers: typecheck + lint + unit + network-e2e-live (the actually-regressed path).

---

## Security & Adversarial Considerations

- **Two fee risks (primary).** Inclusion-reject (committed cap < live fee → DoS, retryable) vs budget-fail (bridged < ceiling → claim reverts). Mitigated by `RELIABILITY_MULT` headroom in the committed cap (inclusion) AND `minFuelFj` ≥ committed ceiling (budget). Over-cap forfeits `ceiling − actual` to the FPC; minimized by choosing the *smallest reliable* multiplier empirically.
- **Stale-fee griefing (codex — real, not residual).** A base-fee spike after claim construction can strand a claim. Mitigation: the predicted-worst-case cap absorbs the window's drift. **Reprice/rebuild is available ONLY pre-inclusion or for a conclusively-dropped tx** (codex round-2 condition 2) — once a claim is included/consumed the FJ leaf is spent and is NOT repriced+replayed; the flow moves to "consumed" handling. If predicted drift is exceeded before inclusion, the fix is a rebuilt+repriced retry (not a bigger bridged amount).
- **Don't pad the general embedded cap.** Headroom is scoped to the private fuel claim (explicit fees); the wallet's general 1.0× embedded cap stays so other embedded dApps that budget at 1.0× aren't broken. **The public `fjwc` path carries the SAME protocol-level inclusion-risk in principle (it commits 1.0× too) — it just lacks the FPC's upfront budget gate, so it's only ever bitten by inclusion-reject, not budget-fail. That latent public-`fjwc` inclusion-risk is a DEFERRED reliability follow-up, NOT proven safe** (codex round-2 condition 3). The wallet's embedded-gated drift fix must not change non-embedded behavior.
- **No contract changes.** Wonderland's FPC is correct + 5.0-consistent; untouched. The wallet's fix + script + manifest only.
- **Least privilege / supply chain.** Deployer key is Sepolia testnet only (`fuel-testnet.ts`); no new secrets/deps; `@wonderland/aztec-fee-payment` already pinned.

## Assumptions

### Facts (verified this session)
1. `PrivateFPC.mint_and_pay_fee` asserts `amount >= getFeeLimit()` (`= gasLimits·maxFeesPerGas`); matches 5.0 `gas_settings.ts`. (3 codex agents)
2. Protocol requires committed `maxFeesPerGas >= live gasFees` at execution (`@aztec/stdlib/src/fees/transaction_fee.ts`); base_wallet prices vs predicted future min fees (`base_wallet.ts`). Fee updates activate ~2 slots; claim prove/sync window is far longer.
3. The wallet caps an embedded FPC payment to `getCurrentMinFees()` (1.0×) and honors an explicit `fee.maxFeesPerGas`.
4. After simulation the wallet refetches+overwrites `maxFeesPerGas` when no explicit value was given → drift.
5. `fuel-testnet.ts` tests only the public fuel claim; calibrates `minFuelFj = 2× transactionFee`.
6. No existing wallet e2e settles the embedded `feePayer` path; the closest only asserts popup state, not settlement (codex `019ee67b`).
7. The wallet does not pad gas on embedded sends; teardown stays 0; so `getFeeLimit` ≈ `simulatedTotalGas · committed maxFeesPerGas`.

### Inferences (unverified — attack these)
- **I1.** A `RELIABILITY_MULT` ≈ 1.5× (base_wallet's general padding) is enough headroom for the private claim's prove→inclusion window on V5. *Attack: is the window long/volatile enough to need more? Phase 2 measures it.*
- **I2.** The dominant inflator is identifiable by logging gasLimit vs maxFeesPerGas separately; the fix targets whichever dominates. *Attack: if the 2-call gasLimit is the driver, a fee-cap change barely helps and minFuelFj must simply be larger — Phase 2 must surface this.*
- **I3.** Scoping headroom to the private fuel claim (explicit fees) leaves the public fjwc + sponsored paths unaffected. **The public fjwc path carries the same latent inclusion-risk (commits 1.0×) — recorded as a deferred follow-up, NOT asserted safe** (codex round-2). *Attack: is the public path's window short enough that 1.0× is fine in practice, or is it luck?*
- **I4 (corrected per codex round-2 — split by failure class).** A stranded claim's recoverability depends on the class: (a) **underpriced / dropped** (pre-inclusion) → the FJ leaf is **unconsumed**, recoverable by a rebuilt+repriced re-claim (NOT "at the FPC balance"); (b) **included / consumed** → the FJ leaf is **spent**, only the FPC-credited remainder (`amount − max_gas_cost`) is recoverable via future FPC use. Neither class loses the principal, but they are different recovery paths. *Attack: any class where the leaf is consumed but no remainder is credited (total loss)?*

### Asks (decisions)
- Resolved with user: general drift fix (embedded-gated) + the user's leeway instinct is CORRECT (headroom in committed cap); run `fuel-testnet` as many times as needed; high quality.
- Superseded: the user picked an existing wallet e2e, but codex showed it doesn't exercise the embedded path → replaced with an embedded-`feePayer` settlement e2e (Phase 3). Flag to user at the gate.
- Open for Phase 2 (empirical): the exact `RELIABILITY_MULT` + `FUEL_FEE_MARGIN`.

## Post-implementation hardening

No `/harden` — testnet fee calibration + scoped wallet fix. Parents carried the bridge security review.

## Decision ledger (light — key calls)

- **Headroom in committed `maxFeesPerGas` (user's instinct, codex-confirmed), NOT only `minFuelFj`.** Two risks (inclusion-reject vs budget-fail) need two mitigations. Round-1 draft's "tight 1.0× + leeway in minFuelFj" was REJECTED — it left inclusion-reject unmitigated. Smallest *reliable* cap, set empirically.
- **Scope headroom to the private fuel claim (explicit fees), not the general embedded cap.** Other embedded dApps assume 1.0×; the wallet's drift fix is gated on embedded payments.
- **Calibrate `minFuelFj` against the committed ceiling, decompose gasLimit vs maxFeesPerGas.** Round-1 calibrated vs actual fee (too low) and didn't isolate the driver (codex I2).
- **Gate on an embedded-`feePayer` settlement e2e.** The e2e first picked doesn't exercise the regressed path (codex).

## Audit verdicts

- **Codex round-1 (`019ee67b`, xhigh): reject** — core leeway decision conflated budget-fit with inclusion-fit; tight 1.0× cap risks inclusion-reject across the proving window; validation gate didn't exercise the embedded path; I2 (drift-dominant) unproven. **All findings folded into this revision** (two-risk design, headroom in committed cap, decompose gasLimit/maxFeesPerGas, embedded-feePayer settlement e2e). Re-audit pending below.
- **Codex round-2 (`019ee67b` resumed, xhigh): conditional approve.** "The corrected two-risk split is now basically right." 3 conditions, **all folded in**: (1) `RELIABILITY_MULT` methodology too weak → use `getPredictedMinFees` (protocol worst-case) as the cap basis, validate empirically (Phase 1/2); (2) stale-fee retryability overstated → reprice only pre-inclusion/dropped; included/consumed → "consumed" handling (Security); (3) I4 unsafe → split recovery by failure class (Assumptions). Scope decision (headroom on private claim only) confirmed correct; public `fjwc` recorded as a deferred reliability follow-up, not safe. **Tier nudge: codex says this is `mid`, not `light`** (spans wallet fee construction + faucet flow + live calibration + new settling e2e) — surfaced to the user at the gate.
