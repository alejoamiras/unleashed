# exit-finish-1: recon

Base: `main` at 90e3e8f. One Sonnet explorer (reuse sweep, six capabilities) plus driver reads. viem 2.57.1.

## The path on main

| Step | Where | What happens |
|---|---|---|
| Fresh finish sends | sdk `flows.ts` `consumeWithdrawal` | `writeContract` → `onSent(H)` persists `consumeTxHash` → `waitForTransactionReceipt({ hash })` (viem default 180 s, replacement tracking on) → returns `{ consumeTxHash: H }` whatever mined |
| Wait A gives up | same | viem throws its timeout; the journal's `surfaceRunFailure` shows "<viem text>. Your funds are not lost — retry from this card."; H stays |
| Wait B | app `useHubExit.ts:313` `waitConsumeReceipt` | `awaitL1Receipt` (8 × 90 s ≈ 12 min, direct receipt probe per round); every throw (revert, timeout) becomes `false` |
| `false` clears H | `useBridgeJournal.ts:1762` (prior hash), `:1916` (fresh hash) | hash removed; note "The (prior) finish transaction failed — finish again from this card. Nothing was lost." |
| Re-finish | `consumeWithdrawal` again | the portal `withdraw` simulate reverts on the consumed message (`OUTBOX.consume`, `TokenPortalImpl.sol:107`); `surfaceRunFailure` note; record open |
| Resume with H | `finishSubmittedConsume` → `verifySendConsume` (`useHubExit.ts:276`) | `getTransaction(H)` throwing (H dropped or replaced) reads as an identity mismatch: "The recorded finish transaction doesn't match this withdrawal — not marking it done…" (unknown-outcome, H kept, every press repeats it) |

viem's wait (`_esm/actions/public/waitForTransactionReceipt.js:127-205`): it fetches the transaction once it is
pending; when the receipt is missing it looks in the polled block for a transaction with the same `from` and `nonce`
and RESOLVES WITH THAT REPLACEMENT'S RECEIPT for every reason (`repriced`, `cancelled`, `replaced`), calling
`onReplaced`. It cannot follow a replacement if it never fetched the original (dropped before the wait began).

## Reuse map

| Capability | Found | Verdict |
|---|---|---|
| L1 receipt wait with probe | sdk `l1-receipt.ts` `awaitL1Receipt` | reuse; it already returns a replacement's receipt, unread today |
| Identity of a finish tx | `useHubExit.ts:276` `verifySendConsume` (to = portal, `withdraw`, recipient, amount, epoch + leaf from the node's witness) | adapt: report "not found" apart from "mismatch" |
| Completion | `useBridgeJournal.ts:1088` `completeWithdraw` (writes only `completedAt`; toast link from its hash) | reuse |
| Position-specific consumed read | sdk `flows.ts:121` `isOutboxMessageConsumed` (portal's `OUTBOX()`, expected hash); `withdrawMessageHash` (`exit-attach.ts:62` computes it for a record) | reuse as a gate only, never to complete (C-11) |
| Pending-past-the-wait state | deposit claims: rounds to a 30-min cap, then a note with no attention, hash kept (`useBridgeJournal.ts:1661`) | precedent for the card state; new copy |
| Replacement by sender + nonce | none (searched `onReplaced`, `replacedTransaction`, `speedup`, `cancel`, `getTransactionCount` in apps/ and packages/) | not built: viem's wait does it while live |
| Browser fixture holding an L1 tx unmined or replacing it | none (`fixtures/l1-wallet.ts` sends through anvil automine; no `evm_setAutomine`, `anvil_dropTransaction`) | not built; unit layer instead |

## Tests to match

`useBridgeJournal.stages.test.ts:231/249` (latch, prior-hash failure: regexes on today's two notes),
`useBridgeJournal.test.ts:386/397` (rediscovered hash waits; identity false), the lock table `:1840-1900` ("a failed
receipt's clear", "a prior hash's clear"), `useHubExit.test.ts:563` (spent message stays open, Outbox read not
called), sdk `withdraw.test.ts`, `l1-receipt.test.ts` (no replacement case today), `BridgeJournalCard.test.ts:240-258`.
Browser: `exits.spec.ts` cells 27, 28, 31b, 31c finish exits; none delays or replaces the L1 finish.

## Collisions and context

- GHSA-5759-977m-gjx3 (C-11, published; fixed in #81): an occurrence the node selects never completes an exit.
  Owner decision P9-03 A: a finish that fails on a spent message stays open with today's error. Known limit #97:
  identical twin exits.
- #121 (SDK private fee bounds) is open; this lane does not touch the fee probe.
- Deposit legs also call `awaitL1Receipt`; a cancelled deposit leg resolves with the cancel's receipt there too.
  Out of scope (not an exit); recorded in the plan for a follow-up decision.
