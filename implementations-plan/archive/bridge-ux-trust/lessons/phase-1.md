# P1 — bridge-core foundations (lessons)

## implementation opened (gate: APPROVE)
Gate outcome: user APPROVE; A1 retain-until-Clear; A2 no-backwards-compat (L15 — legacy keys deleted, v2-only blobs, downgrade attack closed structurally); A3 CSP deferred. Plan frozen at the post-final-codex fold.

P1 scope (from plan.md): `journal.ts` (+test) NEW — schema D1, per-record merge-write, stage derivation, MAX_RECORDS prioritized retention, prune; `recovery.ts` (+test) DELETE; `recovery-crypto.ts` (+test) EXTEND — v2 envelope (`sealDepositEnvelope`/`openDepositEnvelope`, v2-only, no fallback), `sealDepositRecord({sign, binding, meta, trusted})` (trusted ⇒ 1 sign, untrusted ⇒ 2-sign self-test); `seal-trust.ts` (+test) NEW — provider-aware positive-only cache; `index.ts` export swap.

Validation gate: `bun run --cwd packages/bridge-core test && bun run --cwd packages/bridge-core typecheck && bun run lint`.

## P1 COMPLETE
Shipped: `journal.ts` (+22-case test) — schema D1, per-record read-merge-write upsert/patch/rekey, derived stages, MAX_RECORDS prioritized retention, prune, `clearLegacyKeys` (L15, no migration); `seal-trust.ts` (+7-case test) — provider-aware positive-only cache; `recovery-crypto.ts` v2 envelope — `sealDepositEnvelope`/`openDepositEnvelope` (v2-ONLY, bare-secret blobs rejected = downgrade pin), `envelopeMatchesRecord`, `normalizeAmount`, `sealDepositRecord` (trusted ⇒ 1 sign, untrusted ⇒ 2-sign self-test; returns the in-memory key for the zero-signature finalized re-seal), `openDepositRecord`; `recovery.ts`+test DELETED; index exports swapped. Gate: bridge-core 68 tests ✓, typecheck ✓, root lint ✓, faucet typecheck ✓ (no consumer broke).

Gotchas worth keeping: vitest module-level `const` inside a `describe` doesn't leak to sibling describes (the BINDING scoping fixup); `git rm` before fixing `index.ts` re-exports makes typecheck the reliable canary; biome auto-reflows long signatures on `lint:fix` — run it before typecheck to avoid double-churn.

LESSONS_FILE=implementations-plan/archive/bridge-ux-trust/lessons/phase-1.md
