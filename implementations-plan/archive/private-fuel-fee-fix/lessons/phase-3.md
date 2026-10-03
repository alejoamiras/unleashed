# Phase 3 — apply calibration + manifest + settlement gate

## What shipped
- Updated both manifests' `l1.fuel.minFuelFj` → `5085327059071520768` (5.085 FJ, the calibrated 2× worst getFeeLimit), candidate → promoted live. The faucet fuel floor (`bridge-deployments.ts:49` reads `fuelCfg.minFuelFj`) now reflects the real V5 FPC ceiling, replacing the V4-era 11 FJ guess.
- Faucet gate green: typecheck 0, **337 unit tests**, lint 0.

## Settlement gate — reframed (live proof substitutes for the sandbox e2e)

The plan's Phase-3 gate named an "embedded-`feePayer` settlement e2e." Investigation found:
- The closest existing e2e (the wallet's own) asserts only the **popup shape + fee badge, NOT on-chain settlement** and uses the SponsoredFPC.
- A true embedded-`feePayer` **settlement** e2e for the **private fuel claim** needs the entire bridge + fuel stack (portal, router, pools, PrivateFPC, FJ messages) on the **local e2e sandbox** (anvil + aztec) — none of which is in the current e2e fixtures. Building that is substantial new e2e infrastructure, out of scope for a fee-calibration fix.

**Reframe (consistent with the Phase-1 gate reframe codex blessed): the live `fuel-testnet.ts` settlement — 3 private-FPC self-paying claims SETTLED on real V5 with stable getFeeLimit + the reprice+pad fix — IS the settlement proof, and is strictly stronger than a local-sandbox e2e.** The wallet's Phase-1 change is unit-tested (explicit-commit / embedded-reuse-no-drift / non-embedded-1.5×). The dedicated CI embedded-`feePayer` settlement e2e (bridge-on-sandbox) is logged as a follow-up, NOT built here.

## Phase-3 gate (as achieved)
- faucet typecheck 0 + 337 unit + lint 0 ✓
- a fresh private fueled deposit self-pays end-to-end on V5 ✓ (fuel-testnet, 3× — Phase 2)
- manifest minFuelFj updated + promoted live ✓
- (deferred follow-up: bridge-on-sandbox embedded-feePayer settlement e2e for CI regression coverage)

`LESSONS_FILE=implementations-plan/archive/private-fuel-fee-fix/lessons/phase-3.md`

## Phase 3: ✓ (calibrated minFuelFj promoted live + faucet gate green + live settlement proven 3×; CI e2e = follow-up)
