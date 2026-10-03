# faucet-journal-bugs — recon

Read against the base branch (tools app = `apps/tools`, the faucet's new name). Two pinned bugs, both
in the deposit claim path of the bridge journal. Nothing new is built: each fix is a seam in code
that already exists, and the pins that preserved the bugs flip in the same PR.

## Reuse map

| capability | existing code | verdict |
|---|---|---|
| journal record patching | `packages/bridge-core/src/journal.ts` `patchRecord(kv, id, patch)` — re-reads the journal, SHALLOW-merges the patch, stamps `updatedAt`; `useBridgeJournal.ts` wraps it as `patchRecord`/`updateRecord` (sync, `records` refreshed from kv) | reuse-as-is (the shallow merge is the contract every other write relies on — not changed) |
| current-record read | `useBridgeJournal.ts` `records.value.find((r) => r.id === id)` — used at 590 (`fresh`) and 869 (`sent`); but that is this tab's REACTIVE copy, which lags other tabs' writes until the storage event lands; `loadJournal(deps.kv)` (281, `addRecordVerified`'s read-back) is the persisted read | adapt: a journal export `currentRecord(id)` = `loadJournal(deps.kv).find(…)` (kv-fresh, touches no ref) + a deposit-flow `patchFuel(id, captured, patch)` that merges into it and WRITES through the exported `updateRecord` (the characterization harness traces that export) |
| fuel write sites | `deposit-flow.ts` 207/216 (`standaloneClaimed`), 279/292 (deposit-leg event fields), 331 (`latchFuel` over the captured `rec`), 392/554 (`consumed`), 477/486/503 (private claim latch, `fb` captured at builder time), 616/627 (fjwc latch, `fuel` captured at builder time) | adapt: every site spreads a `fuel` captured BEFORE at least one await; route all through `patchFuel` |
| fuel evidence readers | `deposit-flow.ts` 394–402 (`decidePrivateFuelClaim` inputs: `claimAttemptAt` → `attemptAgedOut`, `setupInsufficiency`), 556–567 (`decideFuelClaim` inputs), `lib/fuel-claim-state.ts` 131–154 | reuse-as-is (pure decision tables; the bug is in what they are fed) |
| receipt classification | `lib/claim-receipt.ts` `ClaimReceiptClass = success/dropped/reverted/proposed/pending` (the journal's `deps.claimReceiptStatus`, wired in `useDeposit.ts:161`); `deposit-flow.ts:152` `fuelReceiptStatus` → included/dropped/pending (the FUEL evidence probe: `/checkpointed|proven|finalized|success|mined/` = included; anything else non-dropped = pending) | reuse; NOTE an interaction (below) |
| terminal-revert handling | `useBridgeJournal.ts:937` `reportRevertedClaim` — runtime note + `confirmLandedTxHash: undefined`, hash KEPT; the dropped streak (`advanceReceiptStreaks`, 952) is the precedent that already clears `claimTxHash` on a terminal non-inclusion | adapt: clear `claimTxHash` here too |
| retry entry | `useBridgeJournal.ts:581` `if (rec.claimTxHash) return resumeSentClaim(...)` — hash present ⇒ receipt path, `deps.claim` never invoked (sent-claim monotonicity, pinned) | reuse-as-is: clearing the hash on a terminal revert is what re-opens the send path with zero new branches |
| resume classification | `resumeActionFor` 1104: a deposit with `claimTxHash` is a prompt-free receipt wait (auto-resumed); without it, a SESSION-LIVE record with a leaf is still auto-resumed on reconnect, an idle one is skipped | reuse-as-is: after the clear an idle reverted record waits for RETRY (attention: error); a session-live one auto-resends on reconnect — the dropped-streak clear already behaves so (owner ask A2, pinned) |
| pins | `useDeposit.characterization.test.ts:660` "(BUG PIN) PROPOSED write drops the pre-send claimAttemptAt" (snapshot `fjwc-latch-patches`); `useBridgeJournal.stages.test.ts:434` "(e) (BUG PIN) the reverted-hash trap"; `useFuel.pins`, `fuelClaim.precedence.pins` | flip the two pins; add one for the direct-FJ resurrection (no pin exists — the scope names it but round 1 only pinned the fjwc case) |
| gates | `bun run --cwd apps/tools test` (unit), `bun run --cwd apps/tools test:e2e` (jsdom smokes: `bridge-smoke`, `fuel-smoke`, `tools-smoke` — mock wallet, no network) | reuse-as-is |

## Bug A — what actually goes stale

`deposit-flow.ts` builders capture `rec` / `rec.fuel` when the interaction is BUILT (`buildClaimInteraction`
runs before the arrival gates, line 594 of the journal); `send()` runs minutes later. Every fuel write in
`send()` spreads that captured object, and the journal's merge is shallow, so a nested `fuel` write is a
wholesale replacement:

- **fjwc** (616 → 627): the journal-first latch writes `claimAttemptAt`; the PROPOSED write spreads the
  build-time `fuel` (no `claimAttemptAt`) + `claimTxHash` ⇒ `claimAttemptAt` is gone. Reader: 401
  `attemptAgedOut: fb.claimAttemptAt === undefined || …` is the PRIVATE ladder's input; the public
  ladder (556) does not read it — so for public fjwc the loss is latent today, but the private
  sibling (477 → 486) re-stamps explicitly and the direct-FJ builder (below) does lose state.
- **direct FJ** (`buildFeeJuiceClaimDep`, 329–332 + `fuelClaim.ts` callbacks 200/208/213 and 258/265):
  `latchFuel` reads `rec.fuel` from the BUILD-time record object. `onAttempt` writes
  `setupInsufficiency: false`; `onTxHash` then spreads the stale `rec.fuel` — if the record carried
  `setupInsufficiency: true` from an earlier failed attempt, the PROPOSED write RESURRECTS it. Reader:
  none on this path today — direct-FJ records dispatch at `deposit-flow.ts:650` straight to
  `buildFeeJuiceClaimDep` and never consult `decidePrivateFuelClaim` (codex corrected a first draft
  that credited the private ladder as the reader). The persisted field is wrong, and a future reader
  (or the backup export) would trust it; the fix is data hygiene plus the clean-latch reading the
  ladder's comments promise, not a funds or double-mint issue.
- **private token claim** (477/486/503): all fields re-set explicitly, so nothing is dropped; the
  pattern is the same and goes through the helper for uniformity (byte-identical patches).
- **standaloneClaimed** (207/216, `sendStandaloneFjClaim`): writes the BUILD-time `fuel` handed in from
  632 after up to 40×6 s of inclusion polling — the same stale class (a first draft of this recon
  called it fresh; the fable-role audit corrected it).
- **`reconcileFuelConsumed`** (`useDeposit.ts:83–89`, outside deposit-flow): spreads a `fuel` read
  before `await fuelReceiptStatus` — same class; in the inventory.
- **consumed / deposit-leg** (279/292/392/554): spreads of a `fuel` read just before the write —
  identical output through the helper; routed so no site can regress.

## Bug B — the trap and its fjwc twin

`runReceiptRound` 896: `status === "reverted"` ⇒ `reportRevertedClaim` (note "You can retry from this
card", hash kept) ⇒ `runDepositClaimLocked` 581 routes the retry back to `resumeSentClaim` ⇒ the same
reverted receipt ⇒ the same note. `deps.claim` is never invoked again. Search trail for an existing
escape: `patchRecord(id, { claimTxHash: undefined })` occurs once (the dropped streak, 956); nothing
clears it on revert; the F11 gen fence and the lock do not help (they serialise, they do not re-route).

Interaction checked and CLEARED: an fjwc-fee'd token claim that reverts in app logic still paid its
fee from the CLAIMED FJ (fees are non-revertible; `fuel-claim-state.ts` header says so). Is the fuel
evidence consistent with that after B clears the token hash? Yes — `lib/claim-receipt.ts` documents
that TxStatus is block-finalization state (checkpointed/proven/finalized) with the revert carried
separately in `executionResult`; the journal's probe reads that field (`reverted`), while the FUEL
probe `fuelReceiptStatus` reads only `status` and therefore returns `included` for the same receipt ⇒
`consumed` ⇒ `decideFuelClaim` answers `sponsored` on the retry (never `fjwc` again, never `wait`).
`fuel.claimTxHash` is inside the fuel block and is not touched by B. So B is complete for fueled
records with no third change. (A first draft of this recon proposed one; it was wrong — the
`status.includes("reverted")` fallback in `classifyClaimReceipt` is for a legacy status string, not
the live shape.)
