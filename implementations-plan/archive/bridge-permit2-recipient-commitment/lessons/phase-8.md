# Phase 8 — forward-looking durability + docs

Status: ✓ (gate green)

## Scope (post-WIPE)

The legacy-preservation half of this phase was dropped under the WIPE sign-off (no v1/v2 legacy claim
scripts, no rollback drill, no stale-deployment support — testnet-only infra, nothing to preserve).
What remained: (1) the backup/recovery durability the NEW recipient-committed stack needs, and (2) an
honest docs pass so nothing in the tree still calls a private claim "bearer".

## What shipped

### 1. Durability test (completed earlier in this phase)
`packages/bridge-core/src/recovery-crypto.test.ts` — +2 tests (22→ green, whole bridge-core suite 136
passing):
- The TOKEN `claim_salt` round-trips through the sealed `DepositEnvelopeV2.salt` blob (recoverable
  from a backup).
- A direct-fuel deposit seals BOTH salts; a swap-fueled deposit seals only the token secret — the fuel
  salt is plaintext-journal-only (`journal.bridgeSecretSalt`), NOT in the sealed blob. This scopes the
  "sealed blob is the strand-prevention credential" claim to the token salt, exactly as the docs now say.

### 2. Docs pass (this firing)
- `packages/bridge-core/README.md` — rewrote the "A PRIVATE claim is bearer … recipient-commitment is
  backlog" invariant to "recipient-committed (F-007 closed)": the stored `secret` for a private deposit
  is a per-deposit `claim_salt`; `claim_private` re-derives the consumption secret from
  `(claim_salt, recipient)` in-circuit, so a leaked salt claims only to the bound recipient. Salt is
  now a **strand-prevention + linkage-privacy** credential, not a theft vector. Public path stays raw-secret.
- `packages/bridge-core/src/recovery-crypto.ts` — `DepositEnvelopeV2` doc: "bearer secret" →
  "private claim credential"; added the recipient-committed framing.
- `audit/security/bridge-redteam/report.md` — F-007 heading + status block: CONFIRMED →
  **FIXED** (recipient-committed), with the "relayer capability is the driver, not the Low-2.6 finding"
  framing. Original finding text kept below for the record.
- `audit/security/bridge-redteam/findings/verified.md` — F-007 ledger row verdict → FIXED,
  plus a note block covering the fix AND **INFO-1 as a value-token hard-blocker**.
- `contracts/bridge/evm/README.md` — new "Value-token hard-blockers" section documenting the two A-1
  carry-forwards: (a) **on-chain portal-binding is future work for BOTH the bridge-only and fuel-only
  paths** — the router takes `tokenPortal` as a parameter (generic-router phishing surface), contained
  on testnet by the witness binding + hardcoded faucet config, but MUST become an on-chain allowlist /
  immutable binding for a value token; (b) INFO-1 `MintableERC20` permissionless-mint is not a value token.

## Gate — all green

| Command | Result |
|---|---|
| `bun run lint` | exit 0 (60 pre-existing warnings in test mocks — the `vi.fn` `useArrowFunction` false positives; NONE in touched files; do NOT `lint:fix` them, it breaks `new`-instantiated mocks) |
| `bun run typecheck:all` | all 8 packages exit 0 |
| `bun run test:faucet` | 44 files / 426 tests passed |
| backup-durability test | `bun run --cwd packages/bridge-core test` → 19 files / 136 passed |

## Notes / gotchas
- Docs-only + one comment change ⇒ no type surface moved; typecheck was a formality but the gate
  requires it, so it ran.
- The `bun run lint` warning count is pre-existing and unrelated — verified `lint` exits 0 (Biome does
  not fail on warnings) and grep for touched files in the diagnostics returns nothing.
- F-007 fix requires a FRESH L2 stack (the deployment migration = Phases 6/7, gated on explicit go).
  The OLD bearer deployment retains bearer semantics for its in-flight claims — the docs say so.
