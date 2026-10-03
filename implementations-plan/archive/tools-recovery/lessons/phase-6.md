# Phase 6 — the attach handoff, the affordance, the copy, cells 31b/31c

Arc 3. Gate: the Phase 5 commands green again;
`src/composables/useBridgeJournal src/lib/record-policy src/components/BridgeJournalCard src/composables/useHubExit src/composables/exit-attach src/composables/deposit-reconcile`
(8 files, 273 tests) green; typecheck (app + browser tests) exit 0; `bun run lint` exit 0;
`bun run e2e:tools -- specs/exits.spec.ts` on its own sandbox at retry 0 — see § Cells.

## What landed

- Engine: `findExitTx` dep; `withRecordLock` reports `"ran" | "held"`; `rekeyJournalRecord` split into
  the kv write + `adoptRekey` (session liveness, foreground, id map, runtime carry); `attachAndConsume`
  (exported) — the hash's record lock first, `rekeyRecordWhen` under the journal lock inside it, then
  `runWithdrawConsumeLocked` for the new id in its own error boundary (`surfaceRunFailure(H, e)`);
  `attachExit` replaces the dead `unknown-outcome` branch for send exits: narrates "looking for the
  exit on Aztec", excludes every hash and id the journal holds, and hands the match to
  `attachAndConsume` with the guard (`sameExitSnapshot`, no exit/consume hash, not completed,
  destination free, generation unchanged); "held elsewhere" and "moved" get their notes; without a
  lock API the attach fails closed. `none` / `ambiguous` / `incomplete` notes.
- `useHubExit.ts`: the live exit's re-key + consume goes through `attachAndConsume` (a refused
  handoff means another tab already holds this hash: the provisional copy is discarded);
  `findExitCandidate` adapts the node client (`TxHash.fromString`) and passes the target's identity.
- `record-policy`: `exitAttachable` (FINISH for a hash-less send exit; legacy keeps Discard-only);
  `depositLegRecoverableOf` / `exitAttachableOf` split out for the complexity budget. Card copy.
- L1 fixture: parked holds keep their `perform`; `release()` answers them. Cell 31b flipped to the
  attach; cell 31c added (two tabs, one swallowed exit, a parked portal transaction, one
  `eth_sendTransaction` across both pages).
- Engine tests: attached ⇒ done under the hash with the old id's runtime gone; a throw after the
  re-key reported against the new id; a second FINISH refused by the hash's lock; live exit vs attach
  (held elsewhere); attached but already finished on L1 ⇒ `consumedByOther`; the three notes; a throwing
  search; discarded / identity-moved records never re-keyed; a hash that is already a record refused;
  no lock API ⇒ fail closed while a plain consume runs; an unwired finder keeps today's note; the
  handoff itself (attached, then refused onto an occupied id).

## Lessons

- `runWithdrawConsumeLocked` sat at the complexity ceiling: the hash-less branch lives in
  `recoverExitHash`; `recordState` needed two extractions (`depositLegRecoverableOf`, `exitAttachableOf`)
  and an `idle` alias to stay under 15.
- Arc 3 was re-stacked onto every arc-2 codex fix by plain `git rebase` (local, unpushed).
- The test wallet's per-frame `submitted()` list resets on reload: cell 31b captures the burn's hash
  before the reload and compares the attached record against it afterwards.

## Arc-3 codex loop (post-implementation, `/codex high`, read-only)

**Round 1** — session `01a090dd-d3d5-7fc0-8ba9-489f56db1f8d`, verdict `request-changes` (1 high, 4 medium, 1 low).
Verified against the code, all accepted and fixed in one commit:
- H1 *the live exit discards its provisional record on "held elsewhere", but contention can be
  another tab's attach still awaiting the journal lock — its re-key then finds no source and both
  records are gone* — the provisional record is dropped only once a record with the hash exists.
- M2 *the attach's re-read (`verifyExitTx`) ran outside the search's budget; a hanging node pinned the
  lock and the busy state* — `findVerifiedExitTx` shares one `budgetedReads` with the search
  (`searchExit`); pinned under fake timers.
- M3 *an ordinary FINISH on the already-attached hash (cell 31c's second tab) hit `withRecordLock`'s
  "held" silently* — `withRecordLock` reports `"held-local" | "held-elsewhere"`; both runners' entry
  points note "Another tab is finishing this exit / claiming this deposit - try again in a moment."
  for the cross-tab case only; pinned for the exit and the deposit.
- M4 *no consistent chain snapshot across the scan* — the tip's hash is read before and after; a
  change ⇒ `"incomplete"`.
- M5 *the binary search scans the latest block when every timestamp predates the window* — a tip
  older than the window ⇒ `"incomplete"` (the deposit finder gets the same guard, on arc 2).
- L6 *`token.portal` missing from the re-key guard* — added (the test on it was dropped: the journal
  loader quarantines a record whose portal contradicts its token, so the case cannot be staged).
- Comments: the finder header shortened to index-zero / attribution / incomplete semantics; the
  `adoptRekey` line cut; the handoff doc tightened to lock order, non-reentrancy and error ownership;
  the live exit's comment no longer claims a refusal proves a duplicate.
- Not addressed: "two independent journal instances" (one module instance per test process; the
  browser cell 31c is the two-instance proof).

**Round 2** — resumed, verdict `request-changes` (2 medium, one test-only). Both accepted and fixed:
- M4 during the re-read: `scanExit` hands `{ pick, assertTipUnchanged }` to its callers; the attach
  compares the tip after the `getTxEffect` re-read, the plain search right after the scan. Pinned with
  a fake whose tip hash flips once an `effect:` read has happened.
- The H1 pin now runs through `useHubExit().exit()` with the hash's runner held in the in-memory lock
  table: the provisional record survives, the hash is not a record, nothing is consumed. Lesson: the
  composable re-wires `locks` from its own (node-absent) adapter, so a test's lock table must be
  connected AFTER `useHubExit()`.

## Cells

- `exits.spec.ts` in full (pre-fix build): 27, 28, 29, 30, 31 ✓; 31b and 31c ✘ —
  **"More than one matching exit was found"**: cell 28's two 5-unit private exits to the same L1
  address (one L1 account per spec file) sat inside 31b's window, exactly the documented limitation.
  The attach cells now exit amounts no other cell in the file uses (7 and 9). 31b + 31c alone:
  **2 passed** (3.9 min) — 31b attached, consumed and finished (1.4 min); 31c's second tab
  was told a tab is finishing it, one portal transaction across both (1.7 min).

**Round 3** — resumed, verdict `request-changes` (1 medium) — the plan's three-round stop. The
finding (the attach's `none`/`ambiguous` outcomes returned before the tip check, so a reorg during
the scan could say "no exit was found") is a two-line fix, applied and pinned ("a zero-match scan
that crosses a reorg is incomplete, never none"). Per plan § Post-implementation the per-arc loop stops
here; the fresh cross-arc pass reviews the whole stack, and the residue is surfaced to the owner.

## Cross-arc codex pass (fresh session over the whole stack, `/codex high`, read-only)

**Round 1** — session `01a090f4-8f05-7bc2-b490-12a271e51b3c`, verdict `request-changes` (5 medium,
1 low, 1 test-only). All accepted and fixed on the top of the stack (arc 3), since every finding cuts
across arcs:
- 1 *a discard/replacement during the nullifier read still reached the claim build* — the claim start
  re-checks generation, existence and the claim snapshot after the read.
- 2 *a forged `claimedByOther` preempts the hash-less reconciliation and the receipt round* —
  `markerApplies` (leaf known, no claim hash) scopes the marker branch, the resume rule and the
  policy; elsewhere the marker is ignored and the ordinary recovery runs.
- 3 *a public false marker with open fuel hides CLAIM, and resume was gated on a fuel transaction* —
  a marked, unfinished record is verifiable on the click and on resume whatever its fuel (CLAIM and
  CLAIM YOUR GAS coexist on a public open-fuel record; the card says which does what).
- 4 *a refused live handoff returned the absent hash to the wizard* — `performExit` returns the
  provisional record's id and flags it ("Another tab is finishing this exit…" / "This exit's record
  changed…").
- 5 *local ownership taken only inside the asynchronous lock grant* — `withRecordLock` reserves
  `inFlight` before requesting the lock and releases it on every outcome.
- 6 *the late-switch pin regressed when arc 3 added the pre-scan tip read* — the switch is now reported
  in the closing chain assertion, with the read count asserted.
- Comments per the audit. Not addressed: a browser cell where two preloaded tabs race the attachment
  before either re-keys (the unit pin covers the refused second re-key; cell 31c proves the lock).
- Tests: discard during the probe; forged marker on a hash-less record and on a sent one; public false
  marker with open fuel; the refused handoff's returned id; two immediate local starts.

**Round 2** — resumed, verdict `request-changes` (3 medium, 1 test-only). All accepted and fixed:
- the post-probe check reads storage (`currentRecord`), not the reactive copy that lags another
  tab's storage event; pinned with a KV-only deletion during the probe;
- the completion keeps the ORIGINAL snapshot (`fresh`), so its fuel-identity guard still bites when
  the fuel was swapped during the read; pinned;
- the marker shape requires `messageHash` (a marker without it would verify forever as `unknown`);
  the hub-send fixture now carries one, as every real marked record does; pinned by the fall-through;
- the same-tab duplicate pin runs under a delayed lock grant and inspects the loser while the winner
  is parked; the contradicted test comment cut.

**Round 3** — resumed, verdict **`approve`**: "No new or remaining material findings in the fix diff.
All four round-2 findings are addressed." The cross-arc loop converged.

## Final gates (the final stack)

- `bun run test:all` exit 0 (tools 102 files, bridge-core 49, every package green).
- `bun run lint` and `bun run lint:actions` exit 0.
- Full tools suite in two shards on their own sandboxes, retry 0, on the final SHA: shard 1/2 **34 passed** (28.4 min); shard 2/2 **33 passed** (27.1 min).
  (The same two shards, before the cross-arc fixes: 34 + 33 passed.)
- Delivery follows: `gh stack submit --auto`, `gh pr ready` ×3, the three bodies, checks watched.

## Delivery

- `gh stack submit --auto` → one PR per arc (the task branch → the base branch, then each later
  arc → the arc below it);
  titles set as Conventional Commits, bodies applied, `gh pr ready` ×3 (the draft-time runs are
  cancelled by the ready re-run — expected, as on the earlier readiness stack).
- Checks on every branch: Quality, Tools e2e, Bridge contracts, Lint workflows — all
  **success**; `gh pr checks` PASSING on all three PRs.
- The index row reads "stack open". Merging is the owner's call (`gh stack merge --squash`),
  as is the residue surfaced above (the `standaloneClaimed` latch, `patchFuel`'s live merge).
