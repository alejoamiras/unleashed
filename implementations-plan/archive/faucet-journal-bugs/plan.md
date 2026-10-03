## Outcome

Archived. Seeds retired.

# faucet-journal-bugs — plan (blueprint mid; round-3 plan 5)

Two bugs the round-1 decompositions pinned verbatim, fixed on merit, pins flipped in the same PR.
Recon: `recon.md`.
Audits: codex (blueprint, reject → folded) + fable-role (conditional approve → folded); ledger at the end.

## Success criterion

- Bug A: every fuel write in the claim path merges its explicit fields into the PERSISTED current fuel
  block (a kv-fresh read, not this tab's reactive copy). The fjwc PROPOSED patch carries the pre-send
  `claimAttemptAt`; the direct-FJ PROPOSED patch keeps `setupInsufficiency: false` after `onAttempt`
  cleared it; `reconcileFuelConsumed` cannot overwrite a field written during its await.
- Bug B, per variant after a TERMINAL (checkpointed-or-later) `reverted` receipt — the hash is cleared
  by compare-and-set on the reverted hash, RETRY re-enters the build path, and the outcome is:
  - public token, sponsored / no-fuel fee: a fresh claim is sent;
  - public token, fjwc fee: a fresh claim is sent with the `sponsored` fee (the FJ was consumed in setup);
  - private token, private fuel: the fail-stop "private fuel already consumed" (never re-mint, L11) — a
    dead-end replaced by a true statement, not a resend;
  - direct-FJ (fuel-only bridge, public or private): the builder fail-stops "already included" on an
    included `fuel.claimTxHash`, "still pending" on a pending/unreachable one, and rebuilds only a
    dropped one (never a second claim against a possibly-live one).
  Pending / proposed / dropped-streak receipts behave exactly as today.
- Both pins flip; the listed snapshots change and nothing else; every other tools unit + jsdom e2e
  test is zero-edit green. Manifest stays 35.

## Assumptions

**Facts (verified; file:line in recon.md)**
1. `patchRecord` is a shallow merge that RE-READS the journal from kv first (`bridge-core/journal.ts:217`);
   a nested `fuel` patch replaces the block. The composable's `patchRecord` wrapper reloads `records`
   from kv after every write (`useBridgeJournal.ts:219–222`); other tabs' writes reach `records` only via
   the storage event (238), so `records.value` can lag kv.
2. `buildClaimInteraction` runs before the arrival gates (`useBridgeJournal.ts:594`); `send()` runs
   minutes later, across many awaits.
3. The fjwc `send` writes `claimAttemptAt` then spreads the build-time `fuel` without it (`deposit-flow.ts:616,627`).
4. `latchFuel` spreads `rec.fuel` from the build-time record (`deposit-flow.ts:329–332`); `onAttempt`
   clears `setupInsufficiency`, `onTxHash` spreads the stale block back (`fuelClaim.ts:200/208, 258/265`).
   `sendStandaloneFjClaim` (207/216) writes the build-time `fuel` after up to 40×6 s of polling;
   `useDeposit.ts:88` `reconcileFuelConsumed` spreads a `fuel` captured before an await. Direct-FJ records
   never read `decidePrivateFuelClaim`, so the resurrected flag is behaviourally dead on that path today
   (codex): the fix there is data hygiene for a persisted field a future reader would trust.
5. `reportRevertedClaim` keeps `claimTxHash` (`useBridgeJournal.ts:937`); `runDepositClaimLocked` routes
   any record with a hash to `resumeSentClaim` (581); the dropped streak clears the hash unconditionally
   (956) — a latent cross-tab flaw B must not copy. Locks and the F11 gen map are tab-local (174).
6. A reverted Aztec tx is an included block status with the revert in `executionResult`
   (`@aztec/stdlib` 5.2.0 `tx_receipt.d.ts`; `lib/claim-receipt.ts:14`). The journal's probe reports
   `reverted` only at checkpointed-or-later (a proposed-reverted receipt classifies `proposed`); the fuel
   probe reads only `status` ⇒ `included` at exactly the same point ⇒ `consumed`.
7. The characterization harness traces the EXPORTED `updateRecord` of a mocked `./useBridgeJournal`
   (`useDeposit.characterization.test.ts:293`); `deposit-flow.test.ts:52` replaces `updateRecord` with a
   recorder and never adds records to the journal; its direct-FJ builder mock does not invoke the latch
   callbacks (codex).
8. `sessionLive` records with a leafIndex are auto-resumed on wallet (re)connect (`resumeActionFor` 1109).
9. The persisted hash also drives the card's "claim tx ↗" link (`BridgeJournalCard.vue:271`), the stage
   derivation (`journal.ts:265`), `depositActiveKey` (`bridge-steps.ts:121`) and `backup.ts:113`.
10. Direct-FJ records dispatch at `deposit-flow.ts:650` to `buildFeeJuiceClaimDep`, bypassing both ladders.

**Inferences (surviving both audits)**
- I1. A synchronous kv-fresh read followed by the synchronous write adds no microtask seam and no
  new cross-tab window beyond the one every `patchRecord` already has (re-read, merge, write). True
  cross-tab exclusion needs Web Locks — out of scope, residual R1.
- I2. Deep-merging `fuel` in `bridge-core` is rejected for policy-in-storage; no writer relies on
  omission clearing a fuel field, so the objection is placement, not breakage.
- I3. Clearing on a checkpointed revert treats "checkpointed" as final, consistent with
  `handleSuccessReceipt`; an unproven-epoch prune re-including the tx is the same residual the
  success arm already carries (R2).
- I4. Fueled retries after B are safe by Fact 6 and Fact 10, per the variant table — pinned.
- I5. No copy, testid or persisted-shape change. The reverted note stays verbatim.

**Asks (surfaced, not assumed)**
- A1. Owner: B removes the card's explorer link and the durable evidence of the reverted tx (the note
  carries no hash and dies on reload; `depositTxHash` is not a substitute). Default: accept the loss.
  If forensics are wanted later, a separate `lastRevertedClaimTxHash` (never a routing flag).
- A2. Owner: after B a SESSION-LIVE reverted record auto-resends on wallet reconnect without a click
  (Fact 8) — the dropped-streak clear already behaves so. Default: accept, pinned.
- A3. Owner: cross-tab double prompts/sends (two tabs both passing simulate) are pre-existing and out
  of scope (the round's scope: the F11 fence stays as it is). Residual R1, stated in the PR.

## Architecture & implementation

### A — `currentRecord(id)` (journal) + `patchFuel(id, captured, patch)` (deposit-flow)
```ts
// useBridgeJournal.ts — a kv-fresh, NON-reactive read for read-then-patch sites (codex r2: a
// `reload()` here would invalidate the ref before the write for no reason).
export function currentRecord(id: string): BridgeJournalRecord | undefined {
	return loadJournal(deps.kv).find((r) => r.id === id)
}
// deposit-flow.ts
type FuelBlock = NonNullable<DepositJournalRecord["fuel"]>
/** Merge into the record's PERSISTED fuel block; the captured block is the fallback when the journal
 *  holds no live copy (unit fixtures, a wiped block) — today's behaviour exactly. */
export function patchFuel(id: string, captured: FuelBlock | undefined, patch: Partial<FuelBlock>): void {
	const base = (currentRecord(id) as DepositJournalRecord | undefined)?.fuel ?? captured
	if (!base) return
	updateRecord(id, { fuel: { ...base, ...patch } })
}
```
Every field-level fuel write (`deposit-flow.ts` 207/216/279/292/331/392/477/486/503/554/616/627,
`useDeposit.ts:88`) becomes `patchFuel(id, captured, explicitFields)` with the explicit fields verbatim.
Deliberate whole-block construction stays explicit (codex). Traces stay `journal.updateRecord` with
the merged shape (Fact 7); `deposit-flow.test.ts` takes the captured fallback and is zero-edit green.

### B — terminal revert clears the hash under an expected-hash guard (`reportRevertedClaim`)
```ts
// bridge-core journal.ts — load, guard, write in ONE synchronous span (patchRecord = patchRecordWhen(…, () => true, …)).
export function patchRecordWhen(kv, id, when: (current) => boolean, patch): BridgeJournalRecord | undefined
// useBridgeJournal.ts
function reportRevertedClaim(rec: DepositJournalRecord): "stop" {
	const cleared = journalPatchWhen(deps.kv, rec.id, (live) => live.claimTxHash === rec.claimTxHash, { claimTxHash: undefined })
	if (cleared) { receiptRounds.delete(rec.id); reload() }
	setRuntime(rec.id, { attention: "error", note: <unchanged copy>, confirmLandedTxHash: undefined })
	return "stop"
}
```
Not a CAS — localStorage has none (codex r2): the guard's read and write are one synchronous span,
so the residual window is the same one every `patchRecord` already has, not the poll-to-clear
window a separate read would leave. Synchronous between the gen check and the loop's return; only
the `reverted` arm. The dropped-streak clear keeps its unconditional form — out of scope, noted.

### C — direct-FJ records rebuild a prior fuel claim only once it conclusively dropped (`priorFuelClaimStop`)
Before the builder runs: `fuel.consumed` or an included `fuel.claimTxHash` ⇒ "already included";
a dropped one ⇒ rebuild (as today); pending/unreachable ⇒ "still pending", always. Codex r2 refused
"unreachable" as an argument for the included case; its PR review refused rebuilding on pending
(the persisted window between the nested hash — `fuelClaim.ts` onTxHash — and the top-level hash —
`useBridgeJournal.ts` sendAndWatch — is real, and simulate is not exclusion against a queued tx);
and its second review refused the age-out I had added as a liveness escape (elapsed time is not
evidence the tx vanished — a time-bounded double-send window is an owner-level tradeoff). Residual
R4, surfaced: a pending the node never resolves leaves a direct-FJ record waiting; the private
ladder's own `attemptAgedOut` is the existing precedent if the owner wants that tradeoff.

### Competing outline (rejected; both audits independently agreed)
- A″: deep-merge `fuel` in `bridge-core` `patchRecord` — policy in the storage package.
- B″: keep the hash + persisted `claimReverted` routing flag — four readers of "hash = live claim"
  (Fact 9) plus the backup validators would each need to learn it.

## Security & adversarial considerations
- Double-claim: A changes no decision branch; B re-opens a SEND only behind the engine's simulate gate;
  fueled ladders resolve `sponsored` / `consumed` / simulate-reject per the variant table — never fjwc
  twice, never a second mint.
- Cross-tab: B's CAS against the persisted record mirrors the hash-scoped landed view
  (`bridge-steps.ts:115`); A reads kv-fresh. R1: two tabs can still both simulate and send (pre-existing).
- Tampered localStorage: a wiped fuel block falls back to the captured one (today's behaviour); a
  flipped `isPrivate` can structurally enter the public ladder today and after — the on-chain simulate
  rejects the mismatched claim; L11 is a structural guarantee over untampered records (unchanged, R3).
- Privacy (L11): no path change lets a private fueled record reach the public ladder.

## Test plan (pins first, then the fix, one PR)
1. Flip "(BUG PIN) PROPOSED write drops the pre-send claimAttemptAt" → keeps it; snapshot
   `fjwc-latch-patches` (second patch carries the stamp) — the ONLY existing snapshot that changes
   (the two direct-FJ snapshots stay: latch-callback invocation in the builder mock is opt-in).
2. New (characterization, real journal, opt-in callbacks): seeded `fuel.setupInsufficiency: true` —
   `onAttempt` clears it, `onTxHash` keeps it cleared, the journal ends at `false`.
3. New: stale reactive copy vs fresher kv — a field "another tab" wrote straight to storage between
   build and send lands in both fjwc latch writes.
4. New: `sendStandaloneFjClaim`'s settle merges the persisted block (the largest stale window); and
   `reconcileFuelConsumed` keeps a field written after its read.
5. Flip "(e) (BUG PIN) the reverted-hash trap" → after a checkpointed revert `claimTxHash` is undefined
   and `deps.claim` was NOT called (receipt path verbatim); the next run calls it once and its receipt
   poll runs on `0xnew`; pending / proposed / dropped pins unchanged.
6. New: expected-hash guard — a fresh hash N another tab wrote after this tab's poll on H survives
   the late reverted result.
7. New: after the clear, a SESSION-LIVE reverted record auto-resends on `resumeSessionWork`; an idle
   one waits for RETRY (A2).
8. New: variant outcomes — fjwc-reverted retry writes only the `consumed` promotion and no fjwc latch
   (sponsored); private-fueled revert ⇒ "private fuel already consumed" stop; direct-FJ: included prior
   fuel claim ⇒ "already included" stop, dropped ⇒ rebuilt; plus the live coupling: one
   `{status: checkpointed, executionResult: app_logic_reverted}` receipt classifies `reverted` to the
   journal and `included` to the fuel probe.
9. bridge-core: `patchRecordWhen` applies only while the guard holds, no-ops on a missing id.
10. Gates: `bun run --cwd apps/tools test`, `bun run --cwd apps/tools test:e2e` (bridge/fuel/tools smoke),
    bridge-core `journal.test`, `bun run audit:vue`, `bun test scripts/ci-cd/` (manifest 35, rescore exact).

## Decision ledger
- Helper placement: journal-side kv-fresh READ (`currentRecord`) + deposit-flow WRITE over the exported
  `updateRecord` — fable's placement (trace-preserving) with codex's freshness (persisted, not reactive).
- B: clear with CAS (both audits) over a routing flag; forensics only ever as a separate non-routing
  field (codex) — deferred to the owner (A1).
- Residuals (stated in the PR): R1 cross-tab double send (pre-existing, F11 out of scope); R2
  checkpointed-as-final; R3 L11 under tampered storage (unchanged).
- Corrected on audit: the direct-FJ `setupInsufficiency` consequence (codex); 207/216 and
  `useDeposit.ts:88` as stale sites (fable); the fjwc "wait trap" I first proposed (my own recheck).

## Delivery
One PR `fix(tools): …` on the task branch off the base branch. Pins flip in the same
commit as each fix. Codex: one session — blueprint audit (reject → this fold → re-audit) → PR review
until approve (3-round stop → surface).
