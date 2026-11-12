# exit-finish-1: phase 0 (planning) log

## Recon

- One Sonnet explorer (reuse sweep over six capabilities). Its claims about viem's replacement handling, the two clear
  sites and the swallowed throws were re-read in the tree by the driver; all held.

## Consults

### Codex round 1 (gpt-6.1-sol, high, read-only; fresh session)

- Verdict: reject. Blocking: a2 retired hashes on inconclusive evidence; replacement checks folded unavailability
  into mismatch; a1's outcome changes lacked the owner's sign-off.
- R1 `isOutboxMessageConsumed` answers `false` for unknowable reads (`flows.ts:128-139`): verified, accepted
  (three-state read; unknown keeps the hash).
- R2 a missing hash plus an unspent bit does not prove a drop (one provider's `null` is not global absence):
  accepted; E3 became a policy ask with a nonce-evidence option.
- R3 `verifySendConsume` returns `false` on any throw (`useHubExit.ts:295`): verified, accepted (`FinishIdentity`).
- R4 L1 reads go through the wallet's EIP-1193 provider (`useL1Wallet.ts:28-46`), not a pinned RPC: verified,
  accepted; the plan's trust statement was wrong.
- R5 viem follows a replacement only after it has fetched the original (`waitForTransactionReceipt.js:127-179`):
  verified, accepted (offline replacement is a known limit; E4 says so).
- R6 a1 changes outcomes even with today's strings: accepted (E0).
- Also adopted: `mined` holds only a real receipt; the revert error carries the reverted receipt's own hash.

## Mocks

- The real card on the testnet vite dev build, seeded journal (checked by bridge-core's loader), network cut,
  runtime state set through the journal module; copy for unreachable states set in the page. 13 states × 2 widths.
- Gotcha: `pgrep -f "<pattern>"` also matches the shell running the command when the pattern is in its own command
  line; killing by that pgid killed the tool's shell. Kill by a recorded pgid only.
- Today's first-wait note renders viem's `BaseError.message` whole: "…to be confirmed.Version: viem@2.57.1. Your
  funds are not lost…" (newline collapsed, no space). Existing copy bug; E1 replaces that state.

### Codex final pass (gpt-6.1-sol, high; fresh session), then two resumed verification rounds

- Final pass: reject. N1 (an unverified replacement persisted on `unavailable` later reads `mismatch` and strands
  the record) and N2 (E3(d)'s nonce-plus-unspent reads were not one snapshot, and its copy claimed a replacement).
  Both verified; a1 now judges a replacement from the two transactions `onReplaced` supplies; E3(d) copy changed.
- Resume 1: reject. V1 (a `replaced` verdict can be the same withdraw re-encoded; plausible, deliberate custom
  replacement) → `sameWithdrawCall` decodes both. V2 (a block number is no snapshot across a chain switch or a
  reorg) → finalized block, `assertL1Chain`, `chainChanges` unchanged. Codex also confirmed in an in-memory probe
  that viem resolves a replacement without `onReplaced` only when `confirmations > 1`; the plan keeps one.
- Resume 2: **approve**; no new material defect.
- Observation for later plans: viem's `waitForTransactionReceipt` resolves a cancel's receipt as if it were the
  awaited transaction's; any caller that reads `status` alone can mark a cancelled transaction done.
