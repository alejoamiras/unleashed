## Outcome

Archived. Seeds retired.

# journal-engine-decomposition (arc 4, monster 3 of 3)

Decompose `apps/faucet/src/composables/useBridgeJournal.ts`'s claim engine — the `withRecordLock` callback inside `runDepositClaimInner` (cognitive 114, 120 lines; its wrapper carries a 127-line directive), `runReceiptRound` (33), and `runWithdrawConsumeInner`'s callback (22) — burning all **5** directives in the file. Money path (drives real claims/consumes): behavior-preserving transcription.

## Recon

Unlike monsters 1–2, this file is MODULE-SINGLETON architecture: `records`, `runtime`, `deps`, `secretCache`, `receiptRounds`, `localClaimProvenance`, gen counters, and the `setStep`/`setRuntime`/`patchRecord` writers are all module-scope in the same file. Stages therefore stay IN-FILE as plain module functions — no io bundle, no state injection, no new module. The 114 score is largely INHERITED NESTING (the arrow lives inside `withRecordLock(...)` inside the wrapper — the `createAztecWalletSession` lesson): hoisting the body to a named module function removes that inflation before any real splitting.

**Equivalence proof: the EXISTING 60-test engine suite** (`useBridgeJournal.test.ts`) drives these exact paths over injected fake deps (claim/receipt/recovery/consume/verify), including F11 generation fences, chunked receipt rounds, provenance, mismatch guards, and the withdraw verify/complete matrix — plus batch C's `resumeActionFor` pins. The bar: **green with zero edits**, plus targeted pre-extraction pins for the seams the suite doesn't cover (below).

## Load-bearing invariants (transcribe, never re-derive)

1. **F11 generation fence — AS IT ACTUALLY IS** (codex correction: the draft overstated it): `bumpGen` on entry inside the lock; explicit `genOf(id) !== gen` checks exist ONLY in the receipt polling loop and the chunked re-entry — the recovery/unseal/build/countdown/checkpoint/simulate/send awaits are UNFENCED and rely on `withRecordLock`'s serialization (a newer runner cannot enter until the lock releases; its bumpGen then kills the old runner's rounds). PRESERVE this exact shape — adding fences is hardening, a scope change for the owner, not this refactor.
2. **Recipient guard fail-CLOSED**: no known active account, or a non-string/empty recipient, is a mismatch — never a bypass; exact mismatch copy.
3. **Sent-claim monotonicity**: an existing `claimTxHash` is finished by waiting on ITS EXACT receipt hash, and `deps.claim`/`interaction.send` are NEVER invoked on that path (explicitly trace-pinned); the interactive private re-entry unseals first; stale soft notes cleared on re-entry. **(BUG PIN — preserve verbatim)** the reverted-hash trap: a terminal `reverted` receipt RETAINS `claimTxHash`, so every Retry rechecks the same reverted tx and can never resend despite the UI's copy — pinned as-is, reported to the owner as a follow-up fix candidate.
4. **Leg recovery gating**: recovery only with `depositTxHash` + the dep; the fueled fuel-fields-recoverable extension guarded so the original missing-leaf bail stays reachable; receipt-mismatch vs error classification preserved.
5. **Gate order + narration**: interaction CONSTRUCTION (`deps.claim`) happens BEFORE all three gates — fee/fuel resolution timing and any journal mutations the build performs must not move (codex MEDIUM); then block countdown (display pacing, never an authority) → 5.0 checkpoint gate over the REAL message keys (token + fuel; its own separate 300 budget; its waiting SETS `counted`, selecting the later "message arrived" narration) → the claim-simulate loop as the consumability AUTHORITY, sharing the countdown's 300-iteration budget (zero simulate attempts when the countdown consumed all 300 — exact off-by-one pinned), with the preGated/counted narration rules and `claimable` latching after a successful simulate but before the send.
6. **Send tail**: `patchRecord(claimTxHash)` → `receiptRounds.delete` → provenance add → cross-tab reread guard → receipt round; `withRecordLock` released before the chunked re-entry.
7. **Receipt rounds**: per-poll gen checks, the proposed quiet-flip (once per txHash), checkpointed-success completion with the provenance-gated best-effort message probe, dropped/unreachable streak handling (batch A's `trackDroppedStreak` shape), round budget accounting via `receiptRounds`.
8. **Withdraw consume — journal-first latch**: a fresh `consumeTxHash` is PERSISTED before its receipt wait; success completes from a FRESH reread; prior-hash and fresh-hash receipt failures both clear the hash but with their DIFFERENT copy; the absent verifier defaults `?? true`; the progress callback's proven derivation keeps its `??` fallbacks against runtime.
9. **Claim-material conservation** (codex HIGH): after recovery/unsealing the engine rereads the journal and passes THAT fresh record plus the exact public secret or private `{secretHex, envelope}` to `deps.claim` — losing the envelope salt strands private Fee Juice; using the pre-recovery record loses event-derived leaf/fuel fields.

## Architecture (same-file staging)

1. Hoist the lock callback: `runDepositClaimInner` keeps the lock + gen + chunked re-entry; the body becomes `runDepositClaimLocked(id, gen, interactive): Promise<"continue" | "stop">` (module fn) — the `continueRounds` out-flag becomes the return value.
1b. Gate helpers thread `{ simulateStart, counted }` as an explicit state object (codex's shape, adopted): the countdown returns it, the checkpoint gate takes and RETURNS it (its waiting sets `counted`), the simulate loop consumes it.
2. Split `runDepositClaimLocked` into stage functions (module scope, direct state access): `recipientMismatch(rec)`, `resumeSentClaim(rec, gen, interactive)`, `recoverLegIfNeeded(rec)` → `"recovered" | "waiting" | "bail" | "failed"`, `resolveClaimSecretFor(rec)`, `awaitBlockCountdown(rec, id, budget)` → consumed-iteration count, `awaitCheckpointGate(rec, id)`, `awaitConsumable(interaction, id, preGated, counted, budgetStart)`, `sendAndWatch(rec, id, gen, interaction)`.
3. `runReceiptRound` (33): extract ONLY the success arm (`handleSuccessReceipt(rec, gen)` — provenance + probe + complete); the dropped/unreachable streak mutation stays deliberately FLAT in the poll loop (reconciled: both positions independently landed success-only).
4. `runWithdrawConsumeInner` (22): hoist the callback to `runWithdrawConsumeLocked(id)`; extract `finishSubmittedConsume(rec)` (the consumeTxHash branch).
5. Wrapper directives (127-line) fall out with the hoists.

## Test plan

- The 60-test suite green with zero edits; batch C pins intact.
- Pre-extraction pins (committed first, existing mock style — the codex-completed set): (a) the shared budget's EXACT off-by-one (N countdown ticks → 300−N simulate polls; all-300-consumed → ZERO simulate attempts; the checkpoint gate is its own separate 300); (b) the full order trace `claim-build → countdown → token+fuel checkpoint gate → simulate → send`, with checkpoint waiting propagating `counted=true` into the exact subsequent narration, plus legacy no-messageHash fall-through; (c) preGated negative evidence (skips the countdown deps entirely) + `claimable` latches after a successful simulate but before a rejected send; (d) claim-material conservation — the claim receives the recovery-patched token leaf, BOTH message hashes, fuel amount/index, the exact secret, and the private envelope; plus terminal `receipt-mismatch` vs generic-error classification; (e) sent-claim monotonicity trace (existing hash → its exact receipt; `deps.claim`/send never invoked) + the reverted-hash (BUG PIN); (f) receipt-boundary parity: streaks reset at each 45-poll round boundary, exactly ten exhausted rounds, dropped resets on any non-dropped status, unreachable independence, ONE quiet flip per hash; (g) recipient guard fail-closed: absent connected account AND empty-string recipient both refuse; (h) withdraw latch: fresh-consume failure clears with its copy, hash persisted BEFORE the wait, success completes from a fresh reread, the `?? true` absent-verifier default, progress `??` fallback derivation.
- Gates: `audit:vue`, `test:ci-gating`, faucet suite.

## Rollback

Squash revert stops new bad executions and correctly-persisted records re-enter on the old code path. Residual (stated per codex): it cannot repair a claim/consume that was SENT before its hash was journaled, nor un-complete a record a faulty build wrongly completed — those are manual-recovery territory (the card's recovery affordances + owner tooling).

## Decision ledger (dual positions reconciled — codex session 01a05afa, response-11)

1. **Same-file staging**: both independently YES (the singleton maps/locks/writers are the engine's ownership boundary).
2. **Budget threading**: both explicit; codex's `{ simulateStart, counted }` state-object shape adopted over the draft's bare `budgetStart` (the checkpoint gate must propagate `counted`).
3. **runReceiptRound**: both independently success-arm-only; Architecture step 3 reconciled to match.
4. **Codex conditional-approve conditions, all folded**: F11 invariant corrected to the preserved reality (lock-serialized, sparsely fenced — hardening deferred to the owner); claim-material + send-tail + withdraw-latch invariants added; the pin set completed (budget off-by-one, order trace, preGated negatives, claim-material, sent-claim monotonicity + reverted-hash BUG-PIN, receipt boundaries, recipient fail-closed cases, withdraw latch); rollback residual stated.


## Post-implementation record

Codex loop (arc-4 session), five rounds to approval: round 1 fix-first — new unfenced no-op await seams on previously synchronous paths (the receipt loop's non-terminal settle await, the has-leaf/public-material/preGated fast paths), read-at-call-time dep semantics, and six pin gaps (claim-material salt/fuel-key/public case, preGated both-gates + in-send claimable, checkpoint-budget independence, sent-claim restated, receipt boundaries, withdraw reread). Rounds 2-4 closed the residual seams (terminal-only settle, per-gate await guards via countdownApplies/checkpointApplies, synchronous reportRevertedClaim, claimTarget head-guard extraction) and completed the pins (send-never traced; discard-during-wait reread). One held position accepted: the proposed-write-count is structurally guarded but externally unobservable — left unpinned. Round 5: "Converged; the remaining await-parity seam is closed and the synchronous guard/order semantics are preserved. Verdict: approve." Gates: audit:vue exit 0, test:ci-gating 64, 81 tests (60 + 21 pins) with zero suite edits, vue-tsc clean; manifest 147 → 142.
