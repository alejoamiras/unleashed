# P1 — engine narration + receipt-wait rework (lessons)

## P1 COMPLETE
Shipped in `useBridgeJournal.ts` (+8 new pins, 29 engine tests total):
- `RecordRuntime.step`/`stepDetail` narration set at every transition (unsealing → syncing w/ poll count → sending → confirming w/ cumulative check count → verifying), cleared structurally in `withRecordLock`'s finally.
- Receipt waits: chunked rounds (45×4s ≈ 3 min inside the lock, re-entry OUTSIDE it, `INTER_ROUND_MS` gap) to a 10-round ≈ 30-min soft cap — the cap leaves a "Still confirming — RETRY keeps checking; funds are safe" note, NEVER `unknown-outcome` (reserved for verification refusals). `unreachable` receipt outcome narrates as connectivity, never pending (`useDeposit` wiring maps transport exceptions to it).
- F11 generation token: every runner entry + discard bumps it; rounds check it before every state write; a discard mid-wait kills the chain (pinned).
- F12 provenance: `localClaimProvenance` set ONLY at gate-passed→send in this process; completions with it (and all witness-verified withdraws) schedule the ~8s auto-HIDE (`runtime.hidden` → `visibleRecords` filter) — the record is never discarded (pinned: rediscovered completions stay visible with ✓).
- `lastCompleted` ref exposed as P2's toast hook.

Bugs found by the new pins:
1. `withRecordLock`'s finally RESURRECTED a runtime entry for a record discarded mid-run (the busy/step cleanup re-created the key) — now guarded on record existence.
2. Test-side: the unreachable narration is only observable between the status call and the inter-poll wait — sampling inside the status dep reads the PREVIOUS detail; sample in `waitMs` instead.

Gate: engine 29 ✓ · faucet 184 ✓ · smoke 9 ✓ · typecheck ✓ · root lint ✓.

LESSONS_FILE=implementations-plan/archive/bridge-ux-feedback/lessons/phase-1.md
