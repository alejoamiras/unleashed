# Phase 1 — bridge-core fee-payment primitive

## What shipped
- `packages/bridge-core/src/private-fuel.ts`: `privateFeeJuicePayment(fpc) = new FPCFeePaymentMethod(fpc)` (imported from `@wonderland/aztec-fee-payment/fee-payment-methods`, alongside the existing `PrivateMintAndPayFeePaymentMethod`). TSDoc states the no-refund invariant + when to use it vs `privateMintAndPayFee` (no fresh L1→L2 claim to consume).
- `packages/bridge-core/src/fee-juice.ts`: re-export `maxGasCostFor` from `@wonderland/aztec-fee-payment/utils` — surfaced so the faucet sizes its gate without importing `@wonderland/*` directly (coupling stays in bridge-core).
- `packages/bridge-core/src/artifacts.ts`: re-export `PrivateFPCContractArtifact` from `@wonderland/aztec-fee-payment/artifacts/private`.
- `private-fuel.test.ts`: +2 cases.

## Decisions / gotchas
- **Artifact placement (bundle):** `capabilities.ts` warns the 2.2 MB PrivateFPC artifact must not enter the browser bundle. bridge-core has a dedicated `./artifacts` entry (`@unleashed/bridge-core/artifacts`) separate from the main `.` barrel, isolating the existing heavy bridge/proxy JSONs — so the PrivateFPC re-export went THERE, not the main barrel. The faucet will dynamic-import it (mirroring `readPublicFeeJuiceBalance`'s lazy `import("@aztec/noir-contracts.js/FeeJuice")`) so it stays code-split.
- **`PrivateFPCContractArtifact` is already a loaded `ContractArtifact`** (verified `dist/src/artifacts/PrivateFPC.d.ts:5`) — direct re-export, no `loadContractArtifact` wrap needed.
- **`maxGasCostFor(maxFeesPerGas: GasFees, gasLimits: Gas): bigint`** — arg order is (fees, limits); pinned in a unit test (`0·0 + 100·2 = 200`) because the binding gate depends on it.
- **Single `pay_fee` call:** `FPCFeePaymentMethod.getExecutionPayload().calls` has length 1 (vs `privateMintAndPayFee`'s 2) — pinned in a test, because the faucet manifest scopes `pay_fee` alone (codex Fact 10). A Wonderland change adding a setup call trips here.

## Gate (achieved)
- `bun run --cwd packages/bridge-core typecheck` → clean (`tsc --noEmit -p tsconfig.scripts.json`).
- `bun run --cwd packages/bridge-core test` → **116 passed** (17 files), incl. the 2 new cases.
- `bun run lint` → exit 0 (52 pre-existing repo-wide warnings, none in the changed files; scoped `biome check` on the 4 files clean).

`LESSONS_FILE=implementations-plan/archive/no-fuel-claim-fee-source/lessons/phase-1.md`

## Phase 1: ✓ (primitive + re-exports + pins; bridge-core gate green)
