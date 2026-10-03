# Phase 1 — Reliable, pinned fee cap for the embedded fuel claim (wallet-side)

## What shipped
In the wallet: when an embedded-FPC payment has no explicit `maxFeesPerGas`, the wallet now **reuses the value it already committed pre-sim** instead of refetching `getCurrentMinFees()` post-sim. This kills the drift: the FPC budget is now reasoned against exactly the committed ceiling. Non-embedded paths are untouched (still refetch × the general multiplier).

The plumbing that makes the headroom work (verified, no code change needed): the wallet honors an explicit `fee.maxFeesPerGas`. So a dApp (the faucet's private claim) that passes an explicit predicted-worst `maxFeesPerGas` gets it committed verbatim — the headroom is scoped to that claim, not the general embedded cap.

## Validation results (gate PASSED)
- The wallet's own unit tests cover the three cases: (i) embedded + no explicit → reuses the committed cap (proves no refetch); (ii) embedded + explicit maxFeesPerGas → commits exactly that (predicted-worst headroom path); (iii) NON-embedded + no explicit → still refetches × the general multiplier (proves the fix is embedded-gated, general default preserved).
- `bun run lint`: exit 0.

## Deferred to Phase 2 (where they're live-exercised)
The predicted-worst `maxFeesPerGas` SOURCE — `useDeposit.ts` (faucet UI) + `fuel-testnet.ts` (calibration script) computing `getPredictedMinFees()`-worst and passing it explicitly — lands in Phase 2, because its only meaningful validation is the live private claim settling on V5 (a unit test can't prove inclusion-safety). Phase 1 is the wallet's self-contained drift fix + the plumbing capability that honors explicit fees.

`LESSONS_FILE=implementations-plan/archive/private-fuel-fee-fix/lessons/phase-1.md`

## Phase 1: ✓ (wallet-side drift fix, its 3 drift-fix cases green + lint 0)
