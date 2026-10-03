# Phase 4 — the deposit reconcile in the engine, the affordance, the copy, cells 26d/26e

Arc 2. Gate: the Phase 3
commands green again; `src/composables/useBridgeJournal src/lib/record-policy src/components/BridgeJournalCard`
(200 tests) green; typecheck (app + browser tests) exit 0; `bun run lint` exit 0;
`bun run e2e:tools -- specs/l1-wallet.spec.ts` on its own sandbox at retry 0: **26d passed (36 s)**,
26e failed once on a wrong testid (see below), re-run green — see the boundary section.

## What landed

- Engine: `findDepositTx` dep; `recoverLegIfNeeded` calls `reconcileDepositLeg` for a hash-less
  record — narrates "looking for the deposit on Ethereum", writes the found hash once through
  `patchRecordWhen` under the journal lock with `sameDepositSnapshot` (the claim snapshot + token,
  fuel amounts / secret hash, `createdAt`) and "no hash yet" as the guard; a hash another tab wrote
  meanwhile is used, never overwritten; then the existing receipt-based leg recovery runs on the live
  record. `none` / `ambiguous` / `incomplete` get their notes.
- `record-policy`: `depositLegRecoverable` also for a hash-less schema-3 record with a token block
  (gas-only and legacy keep Discard-only). Card: the "look for it on Ethereum" guidance
  (`depositGuidance`, factored out of `stageLabel` for the complexity budget).
- `useSend.ts`: `findDepositTx` wired with the viem public client, `MANIFEST_CHAIN.l1ChainId` and the
  generation's router.
- L1 fixture: `swallowNext({ to })` — the transaction is broadcast for real, the page's promise parks.
  Cell 26d flipped to that shape (reload → CLAIM finds the deposit → claim lands → done, nothing sent
  twice); cell 26e keeps the never-answered wallet (CLAIM finds nothing → the note → Discard).
- Engine tests: found / none / ambiguous / incomplete / throw / discarded / other-tab hash kept /
  identity moved / gas-only + legacy bail. Policy and card pins.

## Lessons

- **An attention's note is rendered by the rail, not the card's `journalAttention` line.** With an
  attention set, `BridgeJournalCard`'s `note` computed yields null and `BridgePhaseRail` shows the
  note under `TESTIDS.journalStep` (`compactDetail`). Cell 26e first asserted on `journalAttention`
  and timed out with the attention correctly set; recovery cell 24c already read the rail. Assert
  attention notes on `journalStep`.
- The sandbox's build happens at boot from the working tree: editing sources while a run boots
  changes what it tests. Wait for "running playwright" before touching the tree.

## Cells

- `l1-wallet.spec.ts` full file: 26d ✓ (36.0 s), 26 ×3 ✓, 26e ✘ (the testid); 26e alone:
  ✓ (30.8 s). The spec is re-run in full inside the arc-2 shards.

## Arc-2 codex loop (post-implementation, `/codex high`, read-only)

**Round 1** — session `01a090bd-4d05-7c11-8467-f87340c4b380`, verdict `request-changes` (4 medium, 1 low).
Verified against the code, all accepted and fixed in one commit:
- M1 *a chain switch away and back between the two chain assertions* — `chainEpoch` option (the
  provider's `chainChanged` count, `useL1Wallet.chainChanges`), captured before and compared after.
- M2 *scan-wide canonicality: a reorg after `getLogs` can add a match the finder never saw* — the tip's
  block hash is read before the scan and re-read after; a change is `"incomplete"`.
- M3 *a hash another tab wrote is used unverified; the leg recovery reads a receipt without checking
  whose call it was* — only the verified hash proceeds; a different one is kept for that tab's run.
- M4 *no generation check after the journal-lock wait* — added; a discard + restore during the wait
  no longer continues.
- L5 *`fuel.fpc` missing from the snapshot guard* — added.
- Comments: the finder's header and the engine's doc rewritten to the identity / uniqueness / guarded
  write contracts; the policy comment de-contradicted; the mock's comment rewritten; the fixture's
  narrating line cut.
- Tests: chain flap; tip reorg; each fueled calldata field independently; chunk boundary (549|550
  with 100-block chunks); the fake's `getLogs` no longer filters on `to`, so the foreign-`to` case now
  exercises production's check; discard-and-restore while the lock waits; fuel recipient swap; cell
  26d asserts the L2 credit equals the record's amount exactly once.

**Round 2** — resumed, verdict `request-changes` (1 medium): M1 remained partially open — the epoch
comparison ran before the final awaited `getBlock`, so a switch during that read could still pass.
**Accepted, fixed:** tip re-read → chain assertion → epoch comparison last, with no await
after it; pinned by "a switch reported while the LAST read is still pending must count too". No other
findings.

**Round 3** — resumed, verdict `approve-with-fixes` (1 medium, test-only): the late-switch pin flipped
the epoch during the window's binary search, not inside the final tip read, so it passed with the old
ordering. **Fixed**: the flip happens inside the second read of the tip block. No production findings
remain — the arc-2 loop converged.

## Arc-2 boundary

- Full tools suite in two shards on their own sandboxes, retry 0: shard 1/2 **34 passed**
  (29.7 min), shard 2/2 **32 passed** (25.8 min) — `l1-wallet.spec.ts` (26d/26e) inside them. The
  three codex-loop commits landed after that build; they change
  the finder's chain/tip checks, the engine's foreign-hash fallback and the guard, and cell 26d's
  credit assertion — all pinned by the unit suites (whole tools suite 101 files / 1377 green after
  round 1); the final cross-arc gates re-run the whole suite in two shards on the final stack.
- Stack: `gh stack add` for arc 3 (re-stacked onto each arc-2 fix by rebase).
