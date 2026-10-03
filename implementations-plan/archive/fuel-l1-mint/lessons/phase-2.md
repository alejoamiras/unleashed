# Phase 2 — MintFuelAsset card on the Fuel tab + FuelForm default fix

## What shipped
- `components/MintFuelAsset.vue`: mint card mirroring `MintTestUsdc` (card shell + style). Generic CTA
  copy ("MINT TEST $AZTEC", no live `mintAmount()` read — codex). State-driven button: disconnected →
  "CONNECT YOUR ETHEREUM WALLET" (→ `connect`), wrong chain → "SWITCH TO SEPOLIA" (→ `switchToSepolia`),
  else mint (→ `feeAsset.mint`). Binds the DEDICATED `minting`/`mintError` (inline status, no toast).
- Mounted in `FuelView.vue` between `FuelForm` and the YOUR FUELS journal.
- `FuelForm` default amount `12` → `20` (above the 16 floor) — fixes codex's mint→fuel dead-end.
- NEW testids `fuelMintCard`/`fuelMintBtn`/`fuelMintStatus` (NOT reused from MintTestUsdc — both views
  stay mounted under `v-show`, so reused selectors would collide).

## Decisions / notes
- **Chain gate (codex):** did NOT copy MintTestUsdc's connect-only gate. Used `useL1Wallet.wrongChain`
  to require Sepolia; the one button dispatches connect / switch / mint by state so it's always actionable.
- **Smoke-mock drift:** adding MintFuelAsset to FuelView broke `fuel-smoke` (it mounts FuelView with a
  mocked `useL1FeeAsset`/`useL1Wallet` that lacked `minting`/`mintError`/`mint` + `wrongChain`/`connect`/
  `switchToSepolia` → `undefined.value` render crash). Fixed by extending both mocks. The App-level
  `faucet-smoke` uses the REAL composables (disconnected in jsdom → renders the connect state) — fine.

## Validation gate — PASSED
- `bun run --cwd packages/faucet typecheck` → clean.
- `bun run --cwd packages/faucet test` → **393 passed** (35 files; +6 MintFuelAsset component cases).
- `bun run --cwd packages/faucet test:e2e` → **14 passed** (fuel smoke green after the mock fix).
- `bun run lint` → exit 0.
- `bun run --cwd packages/faucet build` → built ✓.

## Post-impl (code-review + codex audit)
- `/code-review` pass: extracted a single `state` computed in MintFuelAsset (label + onClick branched on
  the same connect/switch/mint ladder). Committed separately.
- Codex post-impl audit: no HIGH/CRITICAL; all 4 plan-conditions verified. Fixed the one MED — `mint()`
  now checks the receipt status (`waitForTransactionReceipt` resolves on a mined revert in this viem, so
  a reverted mint was a false "minted"); pinned by a reverted-receipt test. LOW (lifetime handler cache)
  accepted; `approve()`'s identical revert-gap noted as a pre-existing follow-up (out of scope).

LESSONS_FILE=implementations-plan/archive/fuel-l1-mint/lessons/phase-2.md
