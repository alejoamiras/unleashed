# Phase 0: planning log

## Recon

- One Sonnet explorer (reuse sweep, callers, viem fallback, UI of `incomplete`, privacy pin). Findings in `recon.md`.
- Live probes, read-only, keyless (curl and Bun `fetch`):
  - PublicNode Sepolia's log floor rolls with the head: about 10,400 blocks back at head 12,022,430, between 9,900
    and 10,100 at head 12,022,483. It refuses a range across the floor whole. Its receipts below the floor are `null`
    while it serves the transaction: a second silent-absence shape the issue did not name.
  - PublicNode Base Sepolia's boundaries (47,000,000 complete, 46,500,000 earliest) did not move while the head moved
    about 39,000 blocks. `sepolia.base.org` refuses blocks below 46,500,000 with the same message as PublicNode, while
    it serves logs and receipts far below.
  - Twelve keyless Sepolia endpoints tried; only `rpc.sepolia.ethpandaops.io` served old logs, receipts and blocks
    without a rate limit, consistent with PublicNode and Tenderly on every compared range.
  - Probe pitfall: a comparison range that starts below PublicNode Sepolia's floor throws in the reference loop; keep
    reference ranges inside the reference's own retention.

## Consults

- Codex round 1 (`gpt-6.1-sol`, high, fresh session): conditional approve, 7 findings, all adopted or narrowed. Dispositions in
  `plan.md` § Audit verdicts.
- Final fresh Codex pass (new session, full decision trail): conditional approve, 2 findings (a failed probe must
  keep the original `null`; the summary must require A1 and A3 acceptance), both adopted. Resumed verification of
  that session: approve, no regression.
