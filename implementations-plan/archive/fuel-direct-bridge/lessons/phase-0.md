# Phase 0 — Config seam + bridge-core Fuel primitives + fail-closed floor

**Status:** ✓ complete. Gate green: bridge-core 121 tests · typecheck:all exit 0 · lint exit 0.

## What shipped
- `packages/bridge-core/src/fuel.ts` — pure primitives:
  - `planPublicFuelDeposit(recipient, amount)` → recipient-bound, random secret.
  - `planPrivateFuelDeposit(claimer, amount, salt?)` → FPC-bound, secret = `deriveBridgeSecret(salt, claimer)` (NEVER random — anti-stranding), salt persisted.
  - `feeJuiceDepositArgs(plan)` → `[to, amount, secretHash]` for `depositToAztecPublic`.
  - `parseFeeJuiceDeposit(logs)` → leaf index from the portal's `DepositToAztecPublic` event (not the Inbox).
  - `assertFuelClearsFloor(received, floor)` → **fail-CLOSED**: a missing/non-positive floor throws (closes the swap-fuel `if (BRIDGE_FUEL && …)` fail-open, B3).
  - Re-exports `FeeJuicePortalAbi` (one source at the bridge-core boundary).
- `fuel.test.ts` — 9 cases: deposit-arg shapes, public-random vs private-derived secret, the reproducibility/recovery guarantee, the event-absent error, and the fail-closed floor (undefined/zero/below/at-or-above).
- Config seam: new top-level `l1.feeJuice { portal, asset, minFj }` in `testnet-bridge.json` + `FUEL_PORTAL/FUEL_ASSET/FUEL_MIN_FJ` exports in `bridge-deployments.ts`, **decoupled from `BRIDGE_FUEL`**.

## Decisions / notes (no codex consult needed — all mechanical)
- **Addresses lifted, not referenced.** The canonical FeeJuicePortal (`0xd336…`) + L1 fee-asset (`0x762c…`) + floor already lived inside the dead swap block (`l1.fuel`). Copied them into an INDEPENDENT `l1.feeJuice` block so removing the swap stack never disables Fuel (plan §5 DQ2). Runtime `UNDERLYING()` cross-check that validates the portal⟷asset pairing is deferred to Phase 3 (it needs a live client); Phase 0 only establishes the config + the fail-closed floor guard.
- **`FeeJuicePortalAbi` from `@aztec/l1-artifacts` (barrel)** — already a bridge-core dep (flows.ts imports `InboxAbi` the same way). No new dependency.
- **bb crypto works in bridge-core's node test env** — `computeSecretHash` + `deriveBridgeSecret` (poseidon) run fine under vitest/bun (mirrors the existing `private-fuel.test.ts` keystone). No module-load hashing (avoids the jsdom `std::bad_cast` class).
- **Lint:** biome flagged `AztecAddress` as type-only in `fuel.ts` → applied the safe `import type` fix. The 53 repo-wide lint warnings are pre-existing baseline (none in the Fuel files).

## Carry-forward
- Phase 1 (the STOP-gate spike) builds the carrierless private claim payload on top of `planPrivateFuelDeposit` + `privateMintAndPayFee`.
- Phase 3 will call `assertFuelClearsFloor(received, FUEL_MIN_FJ)` before any irreversible private claim, and add the runtime `UNDERLYING()` hard-block.
