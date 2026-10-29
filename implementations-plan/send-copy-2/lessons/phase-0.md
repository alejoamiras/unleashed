# send-copy-2 phase 0: planning consults

## Recon

- One Sonnet explorer listed every testnet cross-chain string on the four surfaces. The gate path and the review's
  error states were traced by hand (`recon.md`).
- The light mocks are static HTML rendered with the repository's Playwright Chromium (`playwright screenshot`,
  `PLAYWRIGHT_BROWSERS_PATH` unset); no sandbox boot was needed for a mock.

## Codex round 1 (gpt-6.1-sol, high): conditional approve

- R6's words are hard-coded in two templates, the band and the review's phone bar; changing `quoteWord` alone
  would not render a signed string. **Demonstrated.** Accepted: the change map names both templates, and a2 shoots
  at phone width.
- a1 changes what a user sees but planned no shots (AGENTS.md § UI changes). **Demonstrated.** Accepted: a1 shoots
  the paused sentence and the re-entered review.
- D2 keeps today's behaviour but does not stop a paused route when the node or a read fails, or the manifest does
  not match. **Demonstrated by control flow.** Accepted: §0 names those cases and the fee consequence, and the plan
  qualifies P9-01's guarantee to an observed pause. No recovery machinery added.
- R5's "Refreshes every 60 s" is false on the review, which expires rather than refreshes (`useCrossChainSend.ts:302-305`
  refreshes only on the amount step). **Demonstrated.** R4's "If it can't enter Aztec" is wider than the condition.
  Accepted: both drafts corrected.
- W1 also renames the amount step's refused-route button (`AmountStep.vue:331`). **Demonstrated.** Accepted: listed
  in OWNER-ASKS rather than splitting the helper.

## Opus Plan critique (same draft): conditional approve

- Accepted, each checked in the tree: §0's cases (as Codex) and the hung read (the node client has no timeout; the
  Ethereum send shares it; no timeout added, as that is a recovery policy); R4 untrue for an expired send, which
  never reaches Ethereum; R2's note false for gas-only, whose fee total has no share (`crosschain-figures.ts:111-114`);
  a1 shots; the before list missed the no-window variants and S2 on the background strip (`SendWizard.vue:1549`);
  cell 53's pause needs its own `try/finally` and the second confirm must beat the 60 s TTL; Security's cache
  sentence held only when the cross-chain check runs first; a backgrounded send can still write an error after
  the reset (D7, a known limit: guarding it needs new state); the exit's selection-time decline goes to the owner as
  §5; the P2 gate's `network.ts` line; never-happens assertions across the two checks and the pass's argument.
- Nothing rejected.

## Codex final fresh pass (gpt-6.1-sol, high): conditional approve

- D2's recovery claim was too strong. A delivery recovers to the user's wallet only when its deposit reverts on
  Ethereum; a manifest mismatch can send a deposit into portals whose frozen `INBOX`/`ROLLUP_VERSION` name another
  rollup. **Plausible, unverified end to end.** Adopted: Security and §0 restated; D2 itself stays the owner's call.
- D7's "needs an epoch" was not shown for every write. **Demonstrated by control flow:** `runCrossChain` writes
  `xcRefusal`/`xcError` after `await xc.send` without re-testing the snapshot. Adopted: guard that write with the
  existing snapshot, plus a regression and its control. `runSend`'s `"declined"` write happens only before any
  record exists, so it needs none. The composables' error writes have no owner (`epoch` serves the grant only);
  guarding them is new coordination state, so they stay a known limit.
- §5 now says the exit's "Sign and send again" does not re-request the grant (`exitGuardRefusal` returns
  `EXIT_NOT_GRANTED`). **Demonstrated.**
- Resumed on the revision: one remaining wording fix (Security's first bullet and §0 A promised wallet recovery
  without "if the delivery reaches Ethereum"). Fixed; resumed again: **approve**.
