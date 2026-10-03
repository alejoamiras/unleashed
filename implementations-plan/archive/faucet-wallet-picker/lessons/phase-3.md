# Phase 3 — E2E + full gates + docs

## What shipped
- `faucet-smoke.test.ts`: `localStorage.clear()` per test (a persisted preference would flip the
  next test into the remembered path with a REAL 1s window); a `connectThroughPicker` helper
  routing the three connect-based scenarios through the picker (asserting the row exists before
  clicking); new case **2b**: a remembered wallet skips the picker straight to verification —
  timer-free by construction (the mock stream yields its sole claimant and ends naturally, which
  resolves the remembered path immediately per the natural-end rule).
- `apps/faucet/README.md`: the connection paragraph now describes the picker, the claimed-not-
  proven identity posture, remember/switch semantics, and the collision fail-closed behavior.
- Follow-ups recorded in plan.md: upstream SDK issue for
  unauthenticated `walletId`; per-panel `VerificationModal` double-render quirk (pre-existing).

## Validation gate (plan Phase 3)
- `bun run lint` → exit 0
- `bun run typecheck:all` → exit 0
- `bun run test:faucet` → 487 passed
- `bun run --cwd apps/faucet test:e2e` → 15 passed (3 files) — exit 0
- `bun run --cwd apps/faucet build` → exit 0
