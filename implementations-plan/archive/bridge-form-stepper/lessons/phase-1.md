# P1 — runtime narration channel + suppression + mapper (lessons)

## P1 COMPLETE
- `BridgeStep` extended with the flow legs; `setRecordStep`/`markApproveOutcome`/`flagRecordError` exported; foreground CAS (`claimForeground`/`releaseForeground` + `activeFlowId`) with `visibleRecords` suppression; the provisional→exit rekey transfers ownership; `__reset` clears it.
- `lib/bridge-steps.ts` — the single mapper: fact-zone latch (claimTxHash→CONFIRM, leafIndex→SYNC/CLAIM, depositTxHash→DEPOSIT, runtime-only pre-zones), runtime refines the active phase + detail, `approveOutcome` carries ⊘/✓ with honest degradation, error/unknown-outcome fail the active phase. 16 matrix pins incl. the between-rounds no-flicker regression.
- `lib/wallet-errors.ts` — `isUserRejection` walks the cause chain for EIP-1193 4001 / `UserRejectedRequestError` / the Aztec explicit-decline wordings; ambiguous RPC failures pinned false.
- Flows: record created BEFORE any signature (strictly earlier than the old seal-first ordering — storage failures now abort before ANY prompt; matrix row 1 became create-then-discard with identical user-visible semantics); `onRecord` hook hands the id to the form at creation; leg narration via `setRecordStep`; the cleanup matrix in both catches (explicit rejection pre-hash ⇒ discard + "nothing was sent"; ambiguous ⇒ `flagRecordError` keeps the record); flows return the record id; withdraw's loose /reject|denied|cancel/ regex replaced by the classifier.
- Engine pins added: CAS trio, reload fail-open, rekey transfer, narration landing. Suites: faucet 219 ✓ · smoke 9 ✓ · typecheck ✓.

LESSONS_FILE=implementations-plan/archive/bridge-form-stepper/lessons/phase-1.md
