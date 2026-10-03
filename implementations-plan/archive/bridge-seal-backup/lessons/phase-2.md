# P2 - faucet export/restore (lessons)

## P2 COMPLETE
- `useBridgeBackup`: trust-aware key derivation (retained same-session key ⇒ 0 sigs; untrusted wallet ⇒ determinism self-test, 2 sigs once, then `markSealTrusted`; trusted ⇒ 1 sig - a non-deterministic signer ABORTS before any file exists); export = seal + object-URL download; restore = parse ladder → deployment/duplicate checks BEFORE any signature → unseal → addRecordVerified (idle card, no auto-claim).
- Surfaces: card ⤓ top-right (unfinished only; done cards keep the ✕; provisional withdraws hide it), stepper ⤓ beside the headline, journal-header RESTORE + hidden picker + empty-state hint; toasts on both paths.
- `getRetainedSealKey` exported from useDeposit (the pre-finalize sealKeys window).
- Gotchas: vi.fn `mockClear` does NOT reset implementations (a non-deterministic mock leaked into later tests - `mockReset` + re-prime in beforeEach); prototype spies (anchor click) leak across tests without `vi.restoreAllMocks`; the journal re-stamps `updatedAt` on restore-write (assert around it).
- Gates: audit:faucet exit=0, audit:vue exit=0. Suites: faucet 264 ✓ smoke 9 ✓ bridge-core 79 ✓.

LESSONS_FILE=implementations-plan/archive/bridge-seal-backup/lessons/phase-2.md

## post-impl close
- Codex post-impl: **approve**, no high/critical. Added its two missing pins same-round (journal RESTORE flow incl. error toast; stepper ⤓ provisional-hide). Documented LOW: cross-tab duplicate TOCTOU between the post-unseal check and the upsert - a fresher same-id record can be overwritten by a restored snapshot (stale-state resurrection only; ids are identity-bound, no fund redirection). Accept for testnet; an insert-only journal write is the fix if it ever matters.
- jsdom gotcha: `Object.defineProperty(input, "files")` needs `configurable: true` to redefine across a test's second pick.

## CROSSING-flash audit (user report: re-engage/restore briefly shows CROSSING then CLAIM)
- ROOT CAUSE: `runtime.claimable` (gate-passed) is runtime-only - restored/reloaded records lose it, so pressing CLAIM re-entered the sync gate whose FIRST probe narrated `syncing` (CROSSING) for one simulate round-trip before flipping to CLAIM. Same mechanics on the form at probe boundaries (the AFK observation).
- FIX: the first gate probe is OPTIMISTIC - narrates `sending` ("checking the message", CLAIM active); narration drops to CROSSING only after a probe actually returns not-ready (at which point CROSSING is true). Pinned both ways (ready record ⇒ never syncing; unready ⇒ sending then syncing). The phase clock handles the rare honest regression via its backward-transition reset.

## fresh-eyes pre-merge audit (subagent, fable/max) - verdict "merge after listed fixes", all folded
- **H1 (insisted)**: BACKUP during SEAL exported a junk file with a success toast (private record pre-envelope has NO recovery material) - `sealBridgeBackup` now refuses unsealed private deposits AND both surfaces hide the ⤓ until `sealedEnvelope` exists. Pinned in bridge-core + stepper.
- **H2 (insisted)**: the engine entrypoints had no top-level catch and EVERY UI call site voids the promise - wallet rejections on CLAIM/FINISH/RETRY vanished (busy cleared, stale prompt copy). `runDepositClaim`/`runWithdrawConsume` now wrap their inner bodies; failures land on the record via `surfaceRunFailure` (humanized + funds-safe copy). Pin updated: the promise RESOLVES, the record carries the error.
- **H3 (insisted)**: mismatch/unseal-failed/tampered/stale attentions hid the only action while their copy instructed action, and the rail showed a calm active prompt. Now: every attention except stale-deployment keeps the button (the runs re-validate guards idempotently), ALL attentions fail the rail's active phase (note renders there), the card note line is soft-notes-only.
- **M1**: a REJECTED unseal signature no longer revokes seal trust ("Signature request declined - press CLAIM when you're ready"). **M2**: `proven` now written from the consume progress stream - the card's "consumable" stage is reachable. **M3**: cross-tab discard during the unseal wait bails instead of TypeError. **M4**: `isFirstSeal` recomputes when records change (the two-signatures note stops lying mid-session). **M5**: armed CONFIRM DISCARD auto-disarms after 6s.
- LOW/quality: deferred `revokeObjectURL` (Safari), export double-click guard, case-insensitive deployment compare on restore, shared 1s app clock (`lib/clock.ts` - N cards no longer mean N timers; card age is now reactive), `exportBridgeWithToast` deduplicates both surfaces' handlers, foreground completions no longer double-notify (receipt + toast), garbled dead CSS selector restored to `.actions`, session wallet ref → shallowRef, amount input aria-label, `sealerL1` header now cross-checked for private deposits (comment overclaim fixed).
- Skipped knowingly: sealKeys session-lifetime on flow failure (LOW, key dies with the tab), per-card disarm on busy-flip (the 6s timer covers it).
