## Outcome

Archived. Seeds retired.

# Bridge seal-backup (per-card recovery file + restore)

Blueprint tier: `light`. One bounded feature: a per-bridge encrypted recovery file ("if you don't want to lose this transaction, download its sealed backup") + a "RESTORE" path that re-creates the pending card on any browser holding the same Ethereum wallet.

Phase-0 decisions (user): **seal everything** (public deposits' plaintext secret never touches disk unprotected); export icon on the cards AND the stepper, with tooltips (discoverability); restore = header button + file picker; tier light.

## Design

### D1 - The file: one record, always sealed, versioned
`unleashed-bridge-backup` v1, JSON:
```json
{ "format": "unleashed-bridge-backup", "v": 1,
  "chainId": 11155111, "portal": "0x…", "bridge": "0x…",
  "direction": "deposit", "id": "<record id>", "sealerL1": "0x…",
  "blob": "<AES-GCM over the FULL journal record JSON>" }
```
- The blob seals the ENTIRE record - for private deposits the inner `sealedEnvelope` rides along (double-sealed, harmless); for public deposits this is what keeps the plaintext `secret` off disk.
- Key derivation REUSES the existing recovery-key scheme (`recoveryKeyMessage` + `recoveryKeyFromSignature`, bridge-core `recovery-crypto.ts`) with the binding `{chainId, portal, bridge, secretHashHex: record.id}` - battle-tested primitive, no new crypto (codex: binding reuse + same-key inner/outer AES-GCM are sound - IVs are random per seal). Same-session deposits reuse the retained in-memory key (`sealKeys`/`secretCache`) = **zero extra signatures**.
- **Export is TRUST-AWARE like the private seal** (codex condition 1): an untrusted `(chainId, addr, provider)` runs the sign-twice determinism self-test (then `markSealTrusted`); a trusted one signs ONCE. Without this, a non-deterministic signer could export a file that can never be restored - the recovery promise must be reliable on FIRST use, public + withdraw included.
- Plaintext header fields (`chainId/portal/bridge/direction/id/sealerL1`) exist ONLY for pre-unseal routing + UX copy. `sealerL1` is a BACKUP-header field (captured at export; it is NOT a journal field for public/withdraw records - codex condition 3). The header is NOT AEAD-bound: a swapped header cannot steal (the blob still refuses foreign keys) but can fake stale/duplicate/wrong-wallet refusals - so every header field is re-checked against the unsealed record, and unseal failures read as "wrong wallet OR a tampered/corrupted file" (codex condition 4).

### D2 - Export surfaces (don't ruin the look)
- **Cards**: a small ⤓ icon in the card's top-right (sibling style to the done-card ✕), shown for UNFINISHED records only (done bridges need no rescue). `title` tooltip: "Download this bridge's recovery file - restores it on any browser with your Ethereum wallet."
- **Stepper**: the same ⤓ beside the headline. Same tooltip.
- **Provisional withdraws (`wd-pending-*`) never export** (codex condition 2): pre-exitTxHash there is nothing restorable (a restored provisional lands in `unknown-outcome`, undriveable). The ⤓ appears for deposits immediately and for withdraws once the record rekeys to its exit hash.
- File name: `bridge-<deposit|withdraw>-<id first 10 chars>.json`. Download via an object-URL anchor (no deps).

### D3 - Restore: header button + picker, validated hard
"RESTORE" text button beside the PENDING BRIDGES heading (+ a hint line in the empty state) → hidden `<input type="file">` → parse → validate → ONE unseal signature → upsert → the card appears + toast.
Validation ladder (each step refuses with specific copy):
1. format/`v === 1` (unknown version ⇒ "newer app needed" copy, never best-effort parse).
2. Deployment binding: header `chainId/portal/bridge` must match the CURRENT deployments (stale ⇒ same `stale-deployment` story as the journal).
3. Duplicate: a record with the same id already in the journal ⇒ "already tracked here" (no overwrite - the journal copy may be FRESHER than the file).
4. Unseal with the CONNECTED L1 wallet's signature (lane `l1`); AES-GCM auth failure ⇒ "Couldn't open this file: it wasn't sealed by the connected Ethereum account, or the file is corrupted/tampered." (an unauthenticated header means we cannot distinguish - the copy must not assert "wrong wallet"; codex condition 4).
5. Decrypted record re-validated with a STRICT deep guard (a dedicated per-direction schema checker - the journal's shallow parse guard is not enough for foreign input; codex), ids/binding/direction cross-checked against the header, provisional withdraw ids refused. Then `addRecordVerified`-style write (verify-after-write), card renders via the normal pipeline.

### D4 - What restore does NOT do
No auto-claim on restore (the no-auto-claim invariant holds - the restored card is a normal idle pending card; the user presses CLAIM). No multi-record "backup.json" (explicit per-bridge files, per the user's framing). No server, no QR, no clipboard.

## Phases

### P1 - bridge-core: the backup module ✓
Files: `packages/bridge-core/src/backup.ts` (`sealBridgeBackup(key, record) → file-json`, `openBridgeBackup(key, file) → record`, `parseBackupHeader(json)` + types/guards), exported from the package index; tests colocated.
Smallest proof: round-trip (seal → open = deep-equal record, public + private + withdraw variants); tampered blob ⇒ throws (AES-GCM auth); wrong key ⇒ throws; header/blob binding mismatch ⇒ refuse; unknown `v` ⇒ explicit version error; header validation matrix.
Validate: `bun run --cwd packages/bridge-core test && bun run --cwd packages/bridge-core typecheck && bun run lint`.

### P2 - faucet: export icons + restore flow ✓
Files: `useBridgeBackup.ts` composable (export: resolve key from retained `sealKeys`/`secretCache` or one `runOnLane("l1")` signature, then object-URL download; restore: picker → ladder → upsert → toast); ⤓ icon in `BridgeJournalCard` (unfinished only) + `BridgeStepper` headline; RESTORE button + hidden input in `BridgeJournal` header + empty-state hint; testids `cardBackup`, `stepperBackup`, `journalRestore`, `journalRestoreInput`; component tests.
Smallest proof: card shows ⤓ only while unfinished; stepper shows ⤓; export invokes the seal with the right binding (mock) and triggers a download (anchor click spied); restore ladder pins - bad format / stale deployment / duplicate id / wrong key each refuse with their copy and write NOTHING; happy path upserts + the card appears; no auto-claim after restore (engine untouched).
Gates: `bun run audit:faucet` + `bun run audit:vue` → codex post-impl audit → manual checklist.

### NEEDS MANUAL TEST (testnet)
1. Mid-CROSSING private deposit: ⤓ from the stepper (zero extra signature - same-session key), wipe site data, RESTORE the file (one signature), card reappears, CLAIM completes it.
2. Same for a PUBLIC deposit (file content is sealed - open the JSON, confirm no plaintext secret).
3. Restore on a browser whose wallet is a DIFFERENT account ⇒ the wrong-key copy, nothing written.
4. Restore a file for an already-tracked bridge ⇒ "already tracked", nothing overwritten.

## Decision ledger
| # | Decision | Source | Rejected |
|---|---|---|---|
| B1 | Always-sealed file via the EXISTING recovery-key scheme; binding keyed on record id | Phase 0 (user) + no-new-crypto rule | plain JSON + warning; private-only feature |
| B2 | Export = card ⤓ (unfinished only) + stepper ⤓, tooltips | Phase 0 (user; discoverability) | seal-time interrupt prompt |
| B3 | Restore = header RESTORE + picker + empty-state hint; hard 5-step ladder; never overwrite | Phase 0 (user) | drag-drop zone; merge-on-duplicate |
| B4 | Per-bridge files only; no auto-claim on restore | user framing + journal invariant | whole-journal backup.json |
| B5 | Export is trust-aware (sign-twice self-test on first use, shared trust cache) | codex condition 1 | blind one-signature export - unrestorable files on non-deterministic signers |
| B6 | Provisional withdraws (`wd-pending-*`) never export/restore | codex condition 2 | "the moment the record exists" - restored provisionals are undriveable |
| B7 | `sealerL1` is a backup-header capture, not a record field; header failures read as tamper-or-wrong-wallet | codex conditions 3+4 | treating the unauthenticated header as trustworthy routing |
| B8 | Strict deep record guard on restore (per-direction schema), never the journal's shallow parse | codex | reusing `parseRecords`' permissive filter for foreign input |

## Security & Adversarial Considerations
- **The file is a sealed bearer credential**: AES-GCM under a key only the sealer's wallet signature derives. Stolen file alone ⇒ useless. Tamper ⇒ auth failure. Attacker-forged file ⇒ cannot produce a blob the victim's signature decrypts; garbage refuses at step 4/5.
- **Header fields are untrusted display/routing data** - every one is re-checked against the unsealed record (a swapped header cannot redirect a restore).
- **No downgrade surface**: v1-only open, exact format match (mirrors the envelope's v2-only rule).
- **Restore writes are validated + verify-after-write**; duplicate ids never overwrite (the journal copy may be fresher than the file - "restoring" an old file over a completed record must not resurrect it).
- **No new crypto, no new deps**: `recovery-crypto.ts` primitives only (WebCrypto AES-GCM-256, key = keccak/sha over the EIP-191 signature - as shipped + audited).
- Signature prompts ride the existing `runOnLane("l1")` lane (no prompt interleaving); export/restore never log secrets, blobs, or signatures.

## Assumptions
**Facts (verified):** `recoveryKeyMessage`/`recoveryKeyFromSignature`/AES-GCM seal+open live in `packages/bridge-core/src/recovery-crypto.ts` and are binding-parameterized; `sealKeys`/`secretCache` retain same-session keys (`useDeposit.ts`, `useBridgeJournal.ts`); the journal upsert path is `upsertRecord` + verify pattern (`addRecordVerified`); deployment constants exposed via `bridge-deployments.ts`; the card top-right slot pattern exists (the done-✕).
**Inferences (attackable):** the deposit-binding reuse (`secretHashHex: id`) is safe for withdraw ids too (exitTxHash as the binding nonce - same uniqueness role); object-URL downloads work in all target browsers without extension CSP friction (plain web app - no extension CSP applies).
**Asks:** none open - Phase 0 resolved crypto, surfaces, restore UX, tier.

## Out of scope
Whole-journal export; QR/clipboard transport; restore-time auto-claim; non-bridge records.

## Audit verdicts
**USER VERDICT: APPROVE** (gate, this session).

- Codex post-impl audit (dir codex-epPvTbhG): **approve** - no high/critical; 2 missing pins added same-round; cross-tab TOCTOU documented LOW.
- Codex audit (light, single pass, dir codex-vSvstNAi): **conditional approve** - 4 conditions (trust-aware export; no provisional-withdraw export/restore; `sealerL1` backup-specific; tamper-honest restore copy + strict deep guard), ALL folded (B5-B8 + D1/D2/D3 rewrites). Confirmed sound: binding reuse, same-key inner/outer AES-GCM (random IVs), light tier (no second auditor needed once tightened).
