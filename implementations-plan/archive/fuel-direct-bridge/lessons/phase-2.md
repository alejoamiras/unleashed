# Phase 2 — Journal/engine generalization (assetKind, envelope stays 1)

**Status:** ✓ complete. Gate green: bridge-core 127 · faucet 341 · e2e smoke 9 · typecheck:all exit 0 · lint exit 0.

## What shipped (3 commits)
- **Data model** (`journal.ts`): additive optional `assetKind: "bridge-token" | "fee-juice"` on `DepositJournalRecord` + `assetKindOf()` helper (absent ⇒ bridge-token; the ONE default-decision site). Envelope schema stays 1 — the loader never gates on per-record schema (`parseRecords:145`), so pre-Fuel journals load every record unchanged (pinned by a regression test).
- **deploymentMatches** (`useBridgeJournal.ts`): branches on `assetKindOf` — fee-juice records bind to `{FeeJuicePortal, L2 FeeJuice address}`, token records to `{L1_PORTAL, BRIDGE}`. Without the branch a Fuel record is wrongly quarantined as stale-deployment.
- **Backup** (`backup.ts` + `useBridgeBackup.ts`): `restoreFile` accepts a token OR a fee-juice file (binding match); `validateBackupRecord` now validates `assetKind` AND the private-fuel extras (`bridgeSecretSalt`/`fpc`/`setupInsufficiency`) — the audit's N2, done here (not Phase 5) so a generalized-but-loose validator never ships. Fee-juice + private-fuel record round-trips (seal→open) with the variant + extras intact.

## Decisions / notes (no codex consult needed — all mechanical after reading the code)
- **Recovery binding is binding-AGNOSTIC.** `recovery-crypto.recoveryKeyMessage` + `useBridgeBackup.deriveKey` derive the per-record key from `record.{chainId,portal,bridge}` — whatever the record carries. So a fuel record needs NO recovery-crypto change: it simply carries `portal = FeeJuicePortal`, `bridge = L2 FeeJuice address` (set at deposit time, Phase 3). The loop flagged "recovery binding → /codex" as a decision, but reading the code made it unambiguous (the binding is data, not logic) — no consult spent.
- **The fuel deployment binding** (recovery-key + backup header + deploymentMatches) is `{chainId, FeeJuicePortal, L2 FeeJuice address}` — the plan's specified choice (§5 DQ2).
- **SCOPE DEFERRAL (logged):** the plan's Phase-2 line "refactor `runDepositClaim` to resolve claim material by variant" is MOVED to **Phase 3**. There is nothing to resolve-by-variant until the fuel claim builder exists; doing it now would be a stub. The claim dispatch is naturally wired in Phase 3 where the fuel deposit+claim lands. Low-risk sequencing adjustment, not a scope change.
- **Test-mock gotcha:** both `useBridgeJournal.test.ts` and `useBridgeBackup.test.ts` `vi.mock("@/contracts/bridge-deployments")` with a STRICT object. Adding any new export (`FUEL_PORTAL`) that the source imports requires adding it to BOTH mocks, or vitest throws `No "FUEL_PORTAL" export is defined on the mock`. Hit it on the backup slice; fixed both.

## Carry-forward
- Phase 3 sets `assetKind: "fee-juice"`, `portal = FUEL_PORTAL`, `bridge = feeJuiceAddress` on the fuel deposit record, and wires the variant-aware claim dispatch in `runDepositClaim` / the claim dep.
- Sealing the private salt into the envelope (the 4-file `DepositEnvelopeV2` change) is Phase 3.
