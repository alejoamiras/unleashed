# Phase 1 ✓ — mechanical bump + break inventory

## Gate result: ✅ all green

- **Pins**: 66 `@aztec/*` + 10 `@alejoamiras/*` → `5.0.0` across the 8 package.json; `@aztec/viem@2.38.2` untouched (verified post-sweep). Patches re-keyed (`@5.0.0` files + `patchedDependencies`) and **verified applied** (both installed packages carry the patch's exports map).
- **Lockfile**: `rm bun.lock && bun install` (hoisted linker held); `rg -c '5\.0\.0-rc\.2' bun.lock` = **0**; `bun install --frozen-lockfile` = no changes (CI equivalence).
- **Machine exception diff** (`scripts/lockfile-exception-diff.ts`; full JSON: `phase-1-lock-diff.json`): 34 Aztec-scope moves (the bump) · **152 changed + 4 added + 23 removed non-Aztec entries — dispositioned below**.
- **Provenance (executable)**: all three `@alejoamiras` lines carry npm registry signatures (keyid `SHA256:DhQ8wR5…`) + SLSA v1 provenance attestations with the EXPECTED subjects — accelerator ← `github.com/alejoamiras/aztec-accelerator@main` commit `507efd9`; standards + fee-payment ← `github.com/alejoamiras/ecosystem-tooling@main` commit `45c0c57`. Tarball shasums: accelerator `0d11b062…`, standards `5ff239df…`, fee-payment `bbac579d…`.
- **Nargo tag→commit SHAs at bump time** (for the Phase-4 pin/assert): `AztecProtocol/aztec-packages v5.0.0` = `c5db195d25e03a01e53e1710bf0dedc741bd0578`; `alejoamiras/ecosystem-tooling v5.0.0` = `45c0c578b7cb5a30001f42f0a3fb0a65d9a0db56` — **which equals the npm attestation commit**: the Noir source tag and the published npm artifacts are the same source revision.
- **bunfig**: comment re-dated (the 5.0.0 set was inside the release-age window at the time; removal follow-up owed). Exclude-list reconciliation vs the NEW lock: **zero changes needed** — every `@aztec` name in the lock (30) is covered; only `@aztec/viem` is uncovered, deliberately (independent line, normal 7-day gate).

## Lock-diff disposition (the 179 non-Aztec entries)

All 152 changed entries are in-range refreshes of ESTABLISHED families, and — the load-bearing property — **the 7-day min-age gate applied to every one of them during this install** (they are not excluded names), so nothing here was inside the release-age window at the time. Families: `@aws-sdk/*` (incl. the `@aws-crypto/*` → internal-checksums restructure that explains most of the 23 removals), `@biomejs/*` 2.5.1→2.5.2 (lint gate watched in Phase 2), `@commitlint/*` 21.1→21.2 (drags `conventional-changelog-*` majors within ITS ranges + the 4 added helper packages), `@oxc-resolver`/`rolldown`/`vite` 8.1.0→8.1.3/`vitest` 4.1.9→4.1.10 (build/test infra — Phase 2 gates exercise them), `puppeteer` 25.2.1→25.3.0, faucet `viem` 2.53.1→2.54.6 + `ox`/`ws` (L1 client — Phase 5 verify-l1/smokes exercise), `bn.js` 4.12.3→4.12.4 patches, misc singles (`fs-extra` 10→11 and `convert-source-map` 1.9→2.0 are parent-range-driven). `react-dom`/`scheduler` REMOVED — dropped out of the storybook dependency graph; nothing imports them directly (build gate proves). No unknown/typosquat-shaped names appeared.

## The REAL break found beyond the changelog: the standards `dist/` removal

`@alejoamiras/aztec-standards@5.0.0` removed its `dist/` mirror (ecosystem-tooling stable-revisit decision) — deep imports move `dist/src/…` → `artifacts/src/…` (identical suffix; exports map now `"./artifacts/*"`). Swept mechanically across 22 files (faucet/bridge-core/e2e fixtures). `@alejoamiras/aztec-fee-payment` KEEPS its `dist/` — untouched (its imports resolve fine; verified 0 refs needed changing).

**Nested-checkout resolution gotcha (cost ~20 phantom errors):** before the sweep, the broken `dist/` imports did NOT fail as "module not found" — Node/TS resolution walked UP past the checkout root into an outer checkout's `node_modules` (still rc.2, still has `dist/`) and produced type-identity mismatch errors. In a checkout nested inside another, ANY import that vanishes from a package can silently resolve against the outer checkout's older copy — recognize the mixed paths in errors as the signature.

## The true Phase-2 checklist

1. **`deriveSigningKey` removed** (TS2305): `apps/faucet/scripts/deploy.ts`, `packages/bridge-core/scripts/{deploy-bridge-testnet,deploy-private-fpc-testnet,deposit-testnet,fuel-testnet,smoke-existing-testnet,smoke-swap-existing-testnet}.ts`. (`packages/bridge-core/scripts/deploy-sandbox.ts` imports `createSchnorrAccount` only — re-check its call shape in Phase 2.)
2. **`createSchnorrAccount` arity** (`apps/faucet/scripts/deploy.ts` TS2554: expected 3-4, got 2) — the signing key is now REQUIRED (upstream kept the `(secret, salt, signingKey)` order; the migration is the semantic two-step through the D7 helper).

Non-typecheck items carried to Phase 2 from the plan: the FPC canonical salt sweep (bridge-core pins), the hardened `check-fpc-version.ts`.

LESSONS_FILE=implementations-plan/archive/aztec-5.0.0-stable/lessons/phase-1.md
