# Phase 11: discovery that finishes at any age

## The defect

Cross-arc round 2 (Codex, verified in memory against the recorded Across delivery): discovery re-scans from the
record's planning height on every run (`chain-scan.ts`: "Nothing is cached between scans") under a 200-read,
45 s budget with 2,000-block chunks. The Ethereum execution and extras scans exhaust it about 200,000 blocks
(about 28 days) after the scan start; a lost source hash's `Transfer` scan does on Base after about 4–5 days, and
on Arbitrum after about a day. Such a record is `incomplete` on every run and never offers its claim. The owner
chose to fix it in this stack, as a new PR.

## Attempt 1: paginated scans with in-memory progress (dropped before code)

Each run would scan a page of chunks, the watcher keeping the next page's start in memory and restarting a pass
from the scan start once a page reached the head. A persisted "scanned through" cursor was rejected first: an RPC
that drops one log would make it pass the real execution for good. The Codex design consult (`gpt-6.1-sol`,
`high`) answered "revise before implementing": a partial source page cannot establish `not-sent` (a resend can
follow a reverted attempt), resetting on a `filled` status can starve later pages, a tail page reaching the head is
not whole-window coverage, a fixed page size does not guarantee progress under the deadline, a pass needs identity
and reorg continuity across pages, and a new non-terminal verdict needs watcher handling. Every concern came from
carrying progress across runs.

## Attempt 2: windows bounded by the fill deadline

No state at all. Every Across fill, slow fills included, reverts past `fillDeadline` (the premise
`expiredOnSource` already rests on; Across's `SpokePool.sol` rejects a fill stamped after it), so the Ethereum
window closes at the first block stamped after it: the authenticated relay's deadline once the source binds, the
record's before. `firstBlockAfter` (`chain-scan.ts`) finds the end by binary search over block timestamps, about 20
reads for a year of blocks; `deposit-reconcile.ts`'s window search now uses it too. Stargate has no deadline and
keeps its window to the head (library only; the app watches only Across).

The first source bound was `fillDeadline + 1 h`, argued from causality (a fillable send was mined before its fill)
and a rollup's clock lead (an hour on Arbitrum, 30 minutes on the OP Stack). Codex round 1 rejected it: a
reverted attempt plus a successful resend past the cutoff finalized `not-sent` (high), and a fill does not prove
the deposit was mined first (medium). Its stronger bound holds without either premise: Across's `_depositV3`
reverts a deposit whose quote is older than the immutable `depositQuoteTimeBuffer`, every deposit entrypoint
reaches it, LI.FI's facet passes the quote through, and our builder quotes before the deadline. So no deposit our
calldata can make lands after `fillDeadline + depositQuoteTimeBuffer`, stale prompts included, and the bounded
window is complete: `not-sent` and `expired-on-source` keep their meaning. Discovery reads the buffer from the
pinned source SpokePool each run; it is 3,600 on Base Sepolia, Base, Arbitrum and Optimism.

Codex's round 1 finding 2 (the record's `fillDeadline` is unauthenticated) was answered, not fixed: the record is
written from the route whose `fillDeadline` built the signed calldata, and the scan already trusts record fields of
the same provenance (`srcScanFromBlock`, `srcSender`, `lifiTxId`) behind the backup key.

Red/green, under "a record its user returns to weeks later" (Ethereum head 400,000 blocks and source head 2,000,000
blocks past the scan starts): a lost hash whose fill is stamped exactly at the deadline; a record whose deadline is
600 s earlier than the relay's; a reverted attempt plus a resend stamped exactly `fillDeadline + 3,600`, which
returns `expired-on-source`. All three return `incomplete: read budget` on the arc 5 code; dropping the buffer from
the bound turns the third red. Discovery suite 27/27, `deposit-reconcile` 35/35.

## Review rounds 2 and 3

Round 2 found two more, both verified and fixed. The sandbox's `TestSpokePool` had no `depositQuoteTimeBuffer()`, so
every lost-hash search in the sandbox (the browser suite's hash-less batch recovery) would have stayed `incomplete`;
the unit mock had hidden it by answering the getter. The mock now has the getter and Across's quote-age check (a
new forge test accepts a quote exactly the buffer old and refuses one second older or ahead); the sandbox quotes on
the source chain's own clock, so nothing in it lands a stale quote. And a SpokePool is UUPS-upgradeable: an
implementation can ship a shorter immutable buffer while a record is in flight. Across's deploy constant
`QUOTE_TIME_BUFFER` is 3600 in all 12 revisions of its `src/consts.ts`, so the bound takes at least that; a new
assertion finds a resend at `fillDeadline + 3,600` while the pool reports 600. Round 2 also withdrew round 1's
record-deadline objection.

Round 3: "No new material findings (moderate confidence; browser and integration gates remain pending)".

## Gate

At the arc 6 head, Foundry 1.7.1 and halmos 0.3.3:

- G0: remappings, `forge build` and the `lifi` profile build exit 0; `forge test --no-match-contract Fork` 162
  passed in 20 suites (the new `TestSpokePool` quote test included); the gas snapshot check passed;
  `forge build --ast --force` exit 0; halmos 15 proofs passed (11, 2, 2). `bun run lint` checked 614 files with no
  fixes applied, complexity baseline OK; `typecheck:all` exit 0; `test:all` design 242, bridge-core 662 passed and
  11 skipped, tools 1759.
- `bun run audit:tools` exit 0; `bun run --cwd packages/bridge-core test:integration` 8 files, 47 passed.
- Red/green: the three "weeks later" tests fail on the arc 5 code with `incomplete: read budget` and pass on the fix.
