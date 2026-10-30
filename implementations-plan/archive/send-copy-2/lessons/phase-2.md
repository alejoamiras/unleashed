# send-copy-2 phase 2 (arc a2): the signed strings and ask42

## Building

- Every "before" string still stood on the merged tree, including S2's two lines in `crosschain-steps.ts`, which
  gas-floor-1 left alone.
- `RETRY_WORDS` is a module-level `IS_MAINNET ? … : …` constant, so it is fixed at import. A test that flips a
  hoisted `net.mainnet` mock never renders its mainnet branch, and the old mainnet outcome test passed blind. Only a
  re-import under `vi.doMock` after `vi.resetModules()` reads mainnet's words. Mainnet's expired `next` is now written
  in `expiredCopy`'s mainnet branch, which reads `IS_MAINNET` at call time.
- Deleting `.testnet,` from a combined selector left two `.note` rules. Merge them when a selector list loses a member.

## Shots

- One kept sandbox served both sets. `UNLEASHED_E2E_KEEP=1` booted and built the before tree. Attaching without
  `UNLEASHED_E2E_REBUILD=1` reused that build, so a retake of the before set stayed "before" even after the source
  had changed. Attaching with it rebuilt the after tree.
- The display-only label patch (`network.ts`: "Base Sepolia", "Ethereum · Sepolia") must be in place when the build
  runs, and is reverted before any gate.
- Staging per surface:
  - expired review: wait out the 60 s TTL;
  - bridging: `relayer.setMode({ kind: "starve-gas" })`;
  - expired card and outcome: `relayer.passOnEthereum(fillDeadline)`;
  - pending Bridge estimate: `l1.holdNext("transaction", { to: diamond })`;
  - unsent card with an open approval: hold the approval with `{ to: token }`, arm `rejectNext("transaction")`, then
    `release()`.
- A switched Ethereum account stands the review down to the amount step, so the review's account notice (W1) is not
  reachable by `setAccount`. W1 was shot on the expired and unsent cards instead.
- The parked wallet covers the Bridge tab: `dispatchEvent("click")` on the tab, as the browser README says.

## Gates

- Under a concurrent sandbox boot, `bridge-generation.test.ts` timed out at 5 s twice (in `test:all` and in
  `audit:tools`). Run alone, it passed 10 of 10 in 3.2 s. On the quiet host both full runs exit 0.

## Codex fix loop

- Round 1 (gpt-6.1-sol, high), **1 material finding**: ask42's constant also reaches mainnet.
  - Kept (D9). The signed words name no network, gas-floor-1's own ask offered the shared constant, and the crossing
    takes about a minute on both networks.
  - Two lows taken: the `DEPOSIT_TAKES` comment's claim that it rounds up, and coverage (W1 on the review, the
    wizard's band, mainnet's retry words and expired box).
- Opus `general-purpose`, beside round 1: the same scope question, and three lows, all taken (the split `.note`, a
  stale "Rebuild" comment in cell 53's helper, the band test gap).
- Round 2, verifying 7edcfab: **no material findings**. D9 matches the originating ask. Converged in 2 rounds.
