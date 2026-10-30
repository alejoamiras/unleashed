---
plan: exit-finish-1
tier: light
driver: claude-code
claude_model: opus
codex_model: sol
code_review: off
explainer: off
eli5_mode: skipped (orchestrator-owned)
status: audited; awaiting the orchestrator and the owner's E0–E4
base: main 90e3e8f
budget: "recon: 1 Sonnet explorer; code-review: off; Codex gpt-6.1-sol at high"
---

# exit-finish-1: an exit finish follows the transaction that lands

## Summary

The app treats "my receipt wait gave up" as "the finish failed" and clears the recorded hash (#100). The fix keeps
the hash as the app's handle on its own transaction and retires it only on evidence. Arc a1 reads what actually
mined; arc a2 keeps a pending finish and decides the unprovable cases. Both change what the card shows, so both wait
for OWNER-ASKS (a1 on E0 alone). Recon: [recon.md](recon.md).

## Outcome & Quality Bar

- **For whom**: a user finishing a withdrawal on Ethereum whose finish transaction is slow, sped up or cancelled.
- **Excellent**: (1) a finish that lands under any hash the app saw ends "done" with that transaction's link; (2) a
  cancelled finish never ends "done"; (3) no card calls a transaction failed, or forgets it, on missing evidence.

## Findings (traced; recon.md has the path)

- **F1 (#100)**: H pending past wait B (≈12 min) → `false` → H cleared, "failed" → H lands → re-finish reverts.
- **F2 (#100)**: H sped up to H′ during wait A → viem resolves H′'s receipt, `consumeWithdrawal` returns H → wait B
  on H times out → as F1.
- **F3 (new)**: H pending in a resumed wait B; the user cancels it → viem resolves the cancel's receipt (`success`)
  → the exit is marked done while its message is unspent, then pruned after 7 days.
- **F4 (#100 variant)**: H replaced or unknown to the provider → `verifySendConsume` folds the lookup failure into
  "mismatch" → "doesn't match this withdrawal", forever.
- Issue claim that did not hold exactly: on the resume path a sped-up hash is not cleared; it ends in F4's note.

## Architecture & Implementation

**a1: classify what mined (E0).** One wait outcome, one settle function; a replacement is judged from the two
transactions viem's `onReplaced` hands over, so no read can leave it undecided.

```ts
export type FinishReceipt = {
  txHash: string; status: "success" | "reverted"
  /** Set when a transaction at the sent nonce replaced the sent one: whether it makes the same withdraw call. */
  replacedBy?: "same-finish" | "other"
}
export type FinishWait = FinishReceipt | "unconfirmed"
waitConsumeReceipt?: (txHash: string) => Promise<FinishWait>
consumeSend?: (rec, onProgress) => Promise<{ consumeTxHash: string; mined: FinishReceipt }>
```

- sdk: `awaitL1Receipt` passes an optional `onReplaced` to viem's wait and throws `L1TransactionRevertedError`
  carrying the reverted receipt's own hash. `sameWithdrawCall(sent, replacement, portalAbi)` (new, `./internal`):
  same `to`, and both decode to `withdraw` with equal arguments (a speed-up, or a re-encoded call). `consumeWithdrawal`
  keeps its wait (three scripts need it), passes `onReplaced`, and returns `mined` with `replacedBy` from it.
- app `useHubExit.ts` `waitConsumeReceipt`: a receipt → `FinishReceipt` (`replacedBy` from `sameWithdrawCall`), the
  revert error → `reverted`, any other throw → `"unconfirmed"`. Both waits keep viem's default of one confirmation,
  where viem always calls `onReplaced` before it resolves a replacement's receipt.
- app `useBridgeJournal.ts` `settleFinish(rec, id, sent, observed, failedNote)` replaces both inline tails:
  1. `replacedBy: "other"` → that nonce went to another call, so the finish never landed: clear with today's note.
     `"same-finish"` (the recorded one was ours, or matched before the wait) → persist its hash under the lock and
     go on. A hash change without `replacedBy`, or a wait that spanned a `chainChanges` tick, settles as
     `"unconfirmed"`.
  2. `success` → `completeWithdraw(fresh record, observed.txHash)`; `reverted` → clear with today's note.
  3. `"unconfirmed"` → today's clear (a2 owns this branch).
- The resume path's identity pre-check is unchanged in a1.

**a2: a pending finish stays pending (E1–E4).**

- `"unconfirmed"` keeps H with E1's card. A throw after `onSent` (wait A's 180 s viem timeout) re-reads the record:
  a stored hash settles through `waitConsumeReceipt` instead of surfacing viem's text.
- `verifySendConsume` returns `"match" | "mismatch" | "unavailable"`; only `match` reaches a wait; an unwired
  verifier is `unavailable` (today's `?? true` goes). `unavailable` means H is missing, which is not evidence of a
  drop. The app then reads the exit's Outbox bit as three states (`isOutboxMessageConsumed` returns `undefined`
  when unknowable; a new `exitMessageSpent` dep): `spent` → open with E4's note, never complete; `unknown` → keep
  H, E1's card; `unspent` → E3's policy. A fresh finish whose simulate fails reads the same bit; spent → E4.
- E3(d), if chosen: persist `consumeNonce` and `consumeFrom` for the current hash (read once after `onSent`;
  cleared whenever the hash changes; a failed read stores nothing). Missing H → on the manifest's chain
  (`assertL1Chain`), take B = the finalized block, read the sender's nonce and the exit's Outbox bit both at B, and
  require `chainChanges` unchanged across the reads. Nonce past `consumeNonce` and unspent at B means whatever took
  that nonce, H included, did not pay this exit, and nothing else can: clear with E3(d)'s copy. Any other answer,
  or any failed check, keeps H. Older records fall back to E3(a).

**File-level change map**

| Arc | Files |
|---|---|
| a1 | sdk `execution/flows.ts`, `execution/l1-receipt.ts`, `internal.ts`; app `composables/useHubExit.ts`, `composables/useBridgeJournal.ts` |
| a2 | the a1 files; sdk `isOutboxMessageConsumed`; `BridgeJournalCard.vue` copy; with E3(d) `packages/bridge-core/src/journal.ts` + `backup.ts` |

**Alternatives not taken**: drop the SDK's own wait (scripts depend on it); check a replacement with
`verifySendConsume` (live reads can fail and strand an unverified candidate; viem already compared both
transactions); find a replacement by an L1 log scan (a window, caps and a recovery search for one residue);
complete from the Outbox read (C-11, P9-03).

## Security & Adversarial Considerations

- **Trust boundary, stated as it is**: L1 receipts and transactions come through the connected wallet's EIP-1193
  provider (`useL1Wallet.ts:28-46`), not a pinned RPC. A provider that fabricates a receipt can complete a record
  today; this plan neither widens nor fixes that. The Aztec node chooses the exit's position (witness, Outbox bit).
- **Completion evidence**: a receipt of the recorded hash, or of a replacement viem found at its nonce and judged
  `repriced` (same target, value and calldata as the recorded one). The Outbox bit never completes; it only picks between "keep waiting" and "keep open with a
  note". A lying node can hold a record open or cost one reverted finish, never close one.
- **Residues**: twin exits (#97); a finish replaced while no wait ran stays open with E4's note (known limit).
- Writes stay under `underJournalLock`; the record lock spans the run. No crypto, privilege or dependency change.

## Assumptions

- **Facts**: (1) viem 2.57.1 resolves a replacement's receipt for every reason, once it has fetched the original
  (`waitForTransactionReceipt.js:127-203`). (2) `waitConsumeReceipt` folds every throw into `false`
  (`useHubExit.ts:313-319`). (3) The clears are at `useBridgeJournal.ts:1763` and `:1917`. (4)
  `verifySendConsume` returns `false` on any throw (`useHubExit.ts:295`). (5) A withdraw with `consumeTxHash`
  resumes prompt-free on reload, under the record guards (`:1935-1938`). (6) `./internal` is workspace-only. (7)
  C-11 (GHSA-5759-977m-gjx3) is published. (8) `isOutboxMessageConsumed` answers `false` for a missing or other
  first message and a missing witness, and throws on a failed RPC (`flows.ts:128-139`). (9) Wait A's timeout
  surfaces through `surfaceRunFailure` and keeps H. (10) viem calls `onReplaced` with `repriced` only when `to`,
  `value` and `input` match (`waitForTransactionReceipt.js:186-196`), before it resolves. (11) A new finish
  simulates first (`flows.ts:70-79`), so a spent message refuses it without gas unless both are in flight.
- **Inferences**: an honest provider answers reads pinned to a finalized block number from that block's state,
  whichever backend serves them (E3(d)'s coherence rests on this; a non-finalized height could reorg).
- **Asks**: E0–E4 in [OWNER-ASKS.md](OWNER-ASKS.md); E3 carries the retry policy and the persistence choice.

## Phases

### Phase 1 (a1): classify what mined ☐ (starts on the owner's E0)

1. In the SDK, add `onReplaced` to `awaitL1Receipt`, `sameWithdrawCall`, `mined` to `consumeWithdrawal`, and the
   revert error with its hash; extend `withdraw.test.ts` and `l1-receipt.test.ts`.
2. Map `waitConsumeReceipt` to `FinishWait` in `useHubExit.ts`; pass `mined` through `runSendConsume`.
3. Add `settleFinish`; route the fresh tail (settles `mined`) and the resume tail through it.
4. Update the stages, lock-table and hub-exit tests to the new dep shapes.

Tests: a sped-up replacement (and a re-encoded same call) completes, persists its hash and raises the toast with
it; a wait spanning a chain change stays unconfirmed; F3 exactly: resume H,
match H, then a cancel mines during the wait → not completed, today's note (fails on the base); a fresh finish
cancelled during wait A clears at once; the recorded hash landing still completes (control); the wiring maps
receipt, revert, timeout and each replacement through viem's real `waitForTransactionReceipt` over a scripted
transport; `sameWithdrawCall` refuses another target, another function and other arguments.

**Gate**: `bun run lint`, `bun run typecheck:all`, `bun run test:all`, `bun run audit:tools` exit 0;
`bun run e2e:tools -- specs/exits.spec.ts --retries=0` green (cells 27, 28, 31b, 31c finish through the new tails).

### Phase 2 (a2): a pending finish stays pending ☐ (starts on the owner's E1–E4)

1. Keep H on `"unconfirmed"`; settle a post-send throw from the stored hash; show E1.
2. Make the Outbox read three-state; wire `exitMessageSpent`; apply E3 and E4 as chosen (E3(d): the two fields).
3. Apply the chosen copy; screenshot each state at 1280 and 390 px, light.

Tests: wait B exhausted keeps H with E1 and resumes on reload (control: a revert still clears); a wait A timeout
settles the stored hash; an unwired verifier never reaches a wait; missing + unknown keeps H with E1's card;
missing + spent stays open with E4's copy and never completes; a fresh simulate failure on a spent message shows
E4; the chosen E3 branch (E3(d): H reverted, both reads at the finalized block, a chain switch keeps H, metadata
cleared on a new hash); the card
renders each chosen state. No e2e scenario: the L1 fixture has no mining or replacement
control, and adding one to the shared anvil for this fix is out of proportion; viem's real wait runs in unit tests.

**Gate**: Phase 1's commands, then `bun run e2e:tools -- specs/exits.spec.ts specs/recovery.spec.ts --retries=0`.

## UI impact

- Owner decisions recorded for this lane: none. a1's transitions are E0; a2's states are E1–E4; mocks for each.

## Issues and asks

- #100: a1 `Refs #100`; a2 `Closes #100`, filing the offline-replacement residue as a closed `known-limit` issue.
- F3: fixed in a1, named in its PR; no issue. Asks: the lane brief names none.
- Out of scope: deposit legs read `awaitL1Receipt` too (a cancelled leg may resolve as the cancel; unverified);
  moving L1 reads off the wallet's provider; the exit fee path; the journal lock.

## Delivery

One PR per arc against `main`, opened after its gate and its Codex loop converge; merge `origin/main` first. a1:
`fix(tools): follow an exit finish the wallet replaced, and never finish one it cancelled`. a2 branches from `main`
after a1 merges, carries the close-out, `Closes #100`. Release steps: none.

## Post-implementation (per arc)

1. Codex `run-codex.sh <prompt> <worktree> high read-only gpt-6.1-sol` on the arc diff with this plan, the
   adversarial ask and the no-over-engineering and comment-quality rules verbatim; fix, commit and resume until a
   round has nothing material; three rounds without converging stop the arc.
2. PR per Delivery; `gh pr checks --watch`. a2's close-out: Outcome block, lessons promotion, open items filed,
   `git mv` into `archive/` in its own commit, one line in `archive/index.md`. After it merges:
   `agent-worktree done exit-finish-1 --merged`.

## Audit

| Round | Verdict | Findings → disposition |
|---|---|---|
| Codex 1 (gpt-6.1-sol, high) | reject | R1 Outbox `false` includes unknown → three-state read, unknown keeps H. R2 missing + unspent is no proof of a drop → E3 is a policy ask (keep, forget, user-driven, or nonce evidence). R3 identity folds unavailability into mismatch → three-way identity (now a2's resume pre-check only). R4 L1 reads go through the wallet's provider → trust statement corrected. R5 offline replacements are not followed → known limit, E4 says so. R6 a1 changes outcomes → E0 with mocks. All verified in the tree and accepted. |
| Codex final (fresh, same model) | reject | N1 an unverified replacement persisted on `unavailable` later reads `mismatch` and strands the record → a1 classifies replacements by viem's own `onReplaced` verdict (no read; E0(iii) dropped). N2 E3(d)'s nonce-plus-unspent predicate was incoherent across reads and its copy claimed a replacement → reads pinned to one block, copy says "didn't go through", metadata bound to the current hash. Also: Fact 3/8 wording, F3's test order, gas wording in E3(b)/(c). All verified and accepted. |
| Codex final, resumed (verification) | reject | N1 closed; viem never resolves a replacement without `onReplaced` at one confirmation (kept explicit). V1 a `replaced` verdict can still be the same withdraw re-encoded (plausible, needs a deliberate custom replacement) → `sameWithdrawCall` decodes both transactions, no read. V2 a block number alone is not a coherent snapshot across a wallet chain switch or a reorg → finalized block, `assertL1Chain`, `chainChanges` unchanged; a wait spanning a chain change stays unconfirmed. Both local, accepted. |
| Codex final, resumed (last verification) | **approve** | V1 and V2 closed; no new material defect demonstrated. |

Size: about 200 lines against light's 150; the overrun is the type block and this four-round ledger, not restatement.

## Seeds (draft, not run)

- `/goal Phase 1 ✓ in implementations-plan/exit-finish-1/plan.md with its gate output in the transcript, the Codex loop converged, and the a1 PR open with green checks.`
- `/loop 15m Drive implementations-plan/exit-finish-1 Phase 1 and its post-implementation steps; start Phase 2 only with the owner's E1–E4.`
