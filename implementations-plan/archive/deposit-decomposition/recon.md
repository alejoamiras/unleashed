# Recon — deposit-decomposition

Target: `apps/faucet/src/composables/useDeposit.ts` (1178 lines). Base: post-arc-3-batch-B (batch C in flight — touches sibling composables, NOT this file; rebase before PR).

## The five baselined functions

| Function | Directives | Shape |
|---|---|---|
| `ensureDepositJournalDeps` | 226 lines | deps-wiring shell holding two inline monsters below |
| └ `recoverDepositLeg` (inline dep) | (counted in parent) | receipt re-probe → per-asset event parse → record patch |
| └ `claim` (inline dep) | 154 lines + cognitive 75 | 4-way fee ladder: fee-juice dispatch / L11 private fuel / public fjwc–standalone–wait / no-fuel gate → interaction builder |
| `useDepositFlow` | 351 lines | composable shell holding `deposit` |
| └ `deposit` | 334 lines + cognitive 132 | guards → cold-check → fuel pre-flight → record+seal → Permit2 approve → fueled leg OR plain leg → claim tail → cleanup-matrix catch |

## Reuse map

| Capability | Existing | Verdict |
|---|---|---|
| Fuel-claim decision tables | `@/lib/fuel-claim-state` (pure, 51 tests) | reuse-as-is (already consumed) |
| Fuel claim interaction | `fuelClaim.ts` `buildFuelClaimInteraction` (own tests) | reuse-as-is |
| Permit2 approve sequencing | `@unleashed/bridge-core` `ensurePermit2Allowance` | reuse-as-is (wrapped by inline `ensurePermit2Approval`) |
| BridgeWithFuel event parse | DUPLICATED 3×: `recoverDepositLeg`, fueled leg, (shape also in `useBridgeJournal` probes) | extract shared `parseBridgeWithFuelEvent(logs)` |
| Finalized-envelope re-seal | DUPLICATED 2×: fueled leg + plain leg (identical bodies, differ only in leafIndex source) | extract `finalizePrivateEnvelope(...)` |
| Best-effort L2 height snapshot | DUPLICATED 2× (`try { Number(await …getBlockNumber()) } catch { undefined }`) | extract `bestEffortL2Block()` |
| Fail-stop `{simulate,send}` pair | inline `stop(why)` in `claim` | keep local (tiny) |
| Cleanup matrix (rejection vs ambiguous) | sibling shape in `useWithdraw.handleWithdrawFailure` (batch C) | mirror the pattern, deposit-specific body (approve-outcome nuance differs) |

## Test coverage today

- `fuel-claim-state.test.ts` (51) pins every ladder decision — the L11/L14/L15 semantics are already table-tested.
- `fuelClaim.test.ts` pins the fee-juice claim builder.
- `BridgeForm*.test.ts` mount the form over mocked flows (fuel slice validation, 18-dec path).
- `useBridgeJournal.test.ts` (60) pins the engine that consumes `connectJournalDeps` — including claim/step sequencing against fake deps.
- **Nothing directly tests `deposit()`'s leg orchestration or `claim`'s ladder wiring** (the decisions are tested; the wiring that feeds them is not).
- No live-network CI gate covers the faucet deposit path; the operational rehearsal is the candidate-first smoke scripts (`smoke-existing-*`, `smoke-swap-existing-*`) run by an operator against testnet.

## Search trail (absences)

- No existing `parseBridgeWithFuelEvent` helper: searched `parseEventLogs`, `BridgeWithFuel` across `apps/faucet` + `packages/bridge-core` — raw `parseEventLogs` calls only.
- No deposit-flow unit test: searched `useDeposit` across `*.test.ts` — component-level mounts only.
