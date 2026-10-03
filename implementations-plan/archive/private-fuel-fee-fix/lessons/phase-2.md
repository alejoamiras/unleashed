# Phase 2 — private-fuel calibration (BLOCKED on a prerequisite; surfaced to user)

## Findings before any live run (saved ≥3 doomed runs)

Investigating how to register the PrivateFPC in `fuel-testnet.ts` (EmbeddedWallet) surfaced three things:

1. **The PrivateFPC salt is `0`** (Fr.ZERO), no constructor args. `getContractInstanceFromInstantiationParams(PrivateFPCArtifact, {salt: 0, publicKeys: default, deployer: ZERO})` reproduces `PRIVATE_FPC_ADDRESS` (`0x1fa8746e…`) exactly. (The salt was never exported — the faucet relies on the wallet auto-registering the instance.)
2. **The 5.0 artifact (`fb6f196`) at salt 0 yields the SAME address** as the V4 (`215fd08`) pin → the V4→5.0 fee-payment artifact bump did NOT move the FPC address. The `PRIVATE_FPC_ADDRESS` pin is still correct for 5.0; no re-pin needed. (Resolves the V4-pin concern.)
3. **The PrivateFPC is NOT deployed on the V5 node.** Contrast: the SponsoredFPC (`0x261366b3…`, deployed during the bridge bring-up) IS deployed on V5; `node.getContract(0x1fa8746e)` returns nothing.

## Why this blocks the calibration

The user's original failure (`amount >= max_gas_cost`) fired in **client-side simulation** — the wallet has the FPC *instance registered* in its PXE, so it can simulate `mint_and_pay_fee` locally even though the contract isn't on-chain. But for the claim to **settle**, the FPC is the on-chain fee payer; its public fee logic must execute on-chain, which requires the contract class + instance to be **deployed** on V5. It isn't (V4 deploy didn't carry to the fresh V5 rollup — same class of issue as the portal/bridge V5 redeploy).

So the fee-math fix (Phase 1 ✓ — pin the ceiling) is **necessary but not sufficient**: even a perfectly-calibrated `minFuelFj` + predicted-worst cap will not settle the private claim until the PrivateFPC is deployed on V5. Running the ≥3 calibration runs before deploying the FPC would just fail to settle every time.

## Decision surfaced to the user (scope addition + on-chain deploy)

Phase 2 now needs a prerequisite the plan didn't include: **deploy the PrivateFPC (class publish + instance at salt 0) on V5**, analogous to the portal/bridge redeploy. This is an on-chain testnet deploy + a scope expansion, so per the `/goal` hard limits ("never expand scope; surface and hold") it's held for the user's go-ahead before proceeding.

Once deployed: register it in `fuel-testnet.ts` via `getContractInstanceFromInstantiationParams(PrivateFPCArtifact, {salt: 0})` + `registerContract`, then the private-claim variant + predicted-worst fee + decompose logging + ≥3 calibration runs can proceed.

`LESSONS_FILE=implementations-plan/archive/private-fuel-fee-fix/lessons/phase-2.md`

## RESOLVED: register-only (codex 019ee697) — no deploy needed

Codex corrected the "must deploy" reading: the PrivateFPC has no public functions / no init, so 5.0 uses it **without any deployment tx**. `node.getContract(0x1fa8746e)==nothing` only means it's not *published for public execution* — irrelevant to this private path. Locally: `registerContract(instance, artifact)` at salt 0 (instance + class — the private-kernel oracle needs both). On-chain: the only requirement is the FPC's public FeeJuice balance, which `FeeJuice.claim(fpc,…)` credits — and `mint_and_pay_fee` does that claim as its first setup call. So the claim produces its own settlement state. The hold is lifted; no deploy, no authorization needed.

## VALIDATION RUN (PRIVATE_RUNS=1) — the private-FPC claim SETTLES ✓

`fuel-testnet.ts` extended with a true private-FPC variant (register FPC at salt 0 — drift-check passed, rebuilt == pinned; bridge fuel to the FPC via deriveBridgeSecret; claim via `privateMintAndPayFee` with `maxFeesPerGas = predictedWorstMinFees`). Result:

```
live contracts registered (+ PrivateFPC 0x1fa8746e…)
PRIVATE+FPC-fuel: committed maxFeesPerGas da=0 l2=1961518510052 (predicted-worst)
PRIVATE+FPC-fuel: claim SETTLED - one tx claimed tokens AND gas (7.2m)
PRIVATE+FPC-fuel: actual fee 1636667184031626240 (~1.64 FJ) | token balance 9.75 AZLO ✓
```

**The full fix chain works on V5:** Phase-1 pin (no refetch-drift) + predicted-worst committed cap + register-only FPC → the private fueled claim SETTLES. This is exactly what was reverting with `amount >= max_gas_cost`. The original failure was the OLD inflated ceiling (post-sim refetch × the general multiplier); the pin makes the committed cap tight (predicted-worst) so the FPC ceiling drops below the bridged FJ.

Calibration note: actual fee ~1.64 FJ (private), ~2.56 FJ (public) — well under the current 11 FJ floor, consistent with the prior ~2.878 FJ canary. So the floor was never too low for the *actual* fee; the bug was the inflated *ceiling*. The receipt doesn't expose gasUsed, so the decompose now derives the FPC ceiling from the fee ratio `actualFee × (committedMaxFees.l2 / liveMinFees.l2)` (grounded; committed da-fee is 0). Full ≥3-run calibration in flight to confirm settlement stability + a stable minFuelFj from the derived ceiling.

`LESSONS_FILE=implementations-plan/archive/private-fuel-fee-fix/lessons/phase-2.md`

## INCLUSION-REJECT caught by the ≥3-run calibration (codex round-2 condition 1, validated live)

The first ≥3-run calibration FAILED at private run 1 with a repeating:
```
maxFeesPerGas.feePerL2Gas (1912527385103) < gasFees.feePerL2Gas (1988808156268)
```
Root cause: `predictedWorstMinFees` was computed ONCE at claim-build time and committed; but the claim submits minutes later (after the message-sync wait), by which point the live base fee had risen ~4% ABOVE the committed cap → the protocol rejects (`maxFeesPerGas < gasFees`). Worse, the retry loop reused the SAME stale `claimFee` object → every retry re-rejected → stranded. This is EXACTLY codex round-2's inclusion-reject risk (distinct from budget-fail) and the user's "multiply for leeway" instinct — both vindicated by a live failure.

**Fix (commit after this finding):**
1. **Re-price per attempt** — `fuel-testnet.ts` now recomputes `predictedWorstMinFees × RELIABILITY_PAD` inside the retry loop, so the committed cap tracks the rising base fee across the long sync wait (self-healing, vs the stranded static cap).
2. **`RELIABILITY_PAD = 1.5×`** (matches base_wallet's minFeePadding) on the committed cap, absorbing intra-attempt base-fee drift during proving. The FPC ceiling scales with it but stays far below the bridged FJ (~hundreds of FJ vs a few-FJ ceiling), so it never strands the budget.
3. Faucet `useDeposit` applies the same 1.5× pad (it re-prices per journal-driven claim retry).

This is why the gate is "≥3 runs" — a single run hid the drift; the calibration sweep exposed it. Re-running PRIVATE_RUNS=3 with the fix.

`LESSONS_FILE=implementations-plan/archive/private-fuel-fee-fix/lessons/phase-2.md`

## ≥3-run calibration GREEN (with reprice+pad)

All 3 private-FPC runs SETTLED; the reprice-per-attempt resolved the inclusion-reject (the `re-pricing…` retries tracked the rising base fee). Stable results:

```
private getFeeLimits (FPC ceiling): 2.543, 2.487, 2.428 FJ
private actual fees               : 1.678, 1.642, 1.619 FJ
committed maxFeesPerGas           : predicted-worst × 1.5 (e.g. l2≈3.0e12)
MIN_FUEL_FJ calibration           : 5085327059071520768 (5.085 FJ = 2× worst getFeeLimit)
```

Conclusion: the FPC ceiling is ~2.5 FJ (stable, with the 1.5× pad baked in); the calibrated `minFuelFj` is **5.085 FJ**. The current manifest floor (11 FJ) is therefore already safe (~4× the worst ceiling, ~2× the calibrated floor). Phase 3 sets the manifest to the calibrated 5.085 FJ (grounded; the old 11 FJ was a V4-era guess).

`LESSONS_FILE=implementations-plan/archive/private-fuel-fee-fix/lessons/phase-2.md`

## Phase 2: ✓ (3/3 private-FPC claims SETTLED on V5 + reprice+pad fix + stable getFeeLimit ~2.5 FJ + minFuelFj 5.085 FJ)
