# Phase A1 — F-005: runSwapBridge fail-closed (PR A)

**Done.** Added a guard at the top of `runSwapBridge` (`packages/bridge-core/src/flows.ts`), before any secret generation or signing: when `isPrivate`, throw if `fuelSecret` is missing (the silent `?? Fr.random()` fallback would strand the FJ — the PrivateFPC claimer can't reconstruct a random secret) or if `fuelRecipient !== PRIVATE_FPC_ADDRESS` (case-insensitive; a non-FPC recipient deposits gas publicly to the wrong L2 address). Public path unchanged.

- Imported `PRIVATE_FPC_ADDRESS` from `./private-fuel` (one-directional; no import cycle — private-fuel is the lower-level keystone module).
- Tests: 2 new cases in `flows.test.ts` ("runSwapBridge injectable fuel secret (L3)" describe) — missing-secret rejects + non-FPC-recipient rejects, each asserting `signTypedData` was NOT called (proves it fails BEFORE signing). Existing private (injected-secret) + public (random fallback) tests unchanged.

**Validation gate (passed):** `bun run --cwd packages/bridge-core typecheck` clean; `bun run --cwd packages/bridge-core test` → 16 files, **109 passed** (was 107 + 2 new).

**Note:** the shipping faucet (`useDeposit.ts`) always passes both correctly, so this is integrator/future-caller protection — no behavior change for the live app.
