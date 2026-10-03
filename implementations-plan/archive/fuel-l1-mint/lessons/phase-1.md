# Phase 1 — Config + composable (`useL1FeeAsset.mint`)

## What shipped
- `public/testnet-bridge.json` `l1.feeJuice.feeAssetHandler = 0x5602c39a…` (pinned per the user's choice).
- `contracts/bridge-deployments.ts` exports `FUEL_ASSET_HANDLER` (with a doc note: pinned address is the
  trust boundary; mint cross-checks `FEE_ASSET()`).
- `useL1FeeAsset`: dedicated `minting` + `mintError` refs (NOT the shared `error`, per codex MED),
  `verifyHandlerAsset()` (fail-closed `FEE_ASSET() == FUEL_ASSET`, cached), and `mint()` (verify →
  `FeeAssetHandler.mint(owner)` → wait → `refresh()`; errors → `mintError`).
- `@aztec/l1-artifacts@5.0.0-rc.1` added as a DIRECT faucet dep (the goal's "faucet only" — avoided
  re-exporting from bridge-core). `FeeAssetHandlerAbi` imported from it.

## Decisions / notes
- **ABI source (faucet-only):** bridge-core re-exports only `FeeJuicePortalAbi`. Rather than touch
  bridge-core, added `@aztec/l1-artifacts` to the faucet deps + imported `FeeAssetHandlerAbi` directly
  (the faucet already imports many `@aztec/*` packages directly). `bun install` linked it (already in
  the monorepo via bridge-core; no new download).
- **Codex condition (shared error):** `mint()` uses `mintError`/`minting`, never the shared `error` that
  the deposit flow + balance poll also write — a test asserts `error` stays null on a no-wallet mint.
- **Test mock:** typed `readContract` mock to accept `{ functionName }` so the mint cross-check
  (`FEE_ASSET`) + the post-mint `balanceOf` refresh are mocked order-independently via `mockImplementation`.

## Validation gate — PASSED
- `bun run --cwd packages/faucet typecheck` → clean.
- `bun run --cwd packages/faucet test src/composables/useL1FeeAsset.test.ts` → **12 passed** (8 + 4 new:
  mint success, mismatch-refuse, no-wallet→mintError-not-error, failing-mint).
- `bun run lint` → exit 0.

LESSONS_FILE=implementations-plan/archive/fuel-l1-mint/lessons/phase-1.md
