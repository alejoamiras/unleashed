# gas-floor-1 phase 0: planning

## Recon

- One Sonnet explorer (reuse sweep). Its claim that slippage alone can cause a `floor` refusal is wrong:
  `max(q·(1−s), m) > q` only when `m > q` (recon fact 3).
- Live reads (public endpoints, no key): Sepolia swapper quotes (1 USDC → 32 FJ, 0.3 → 9.6 FJ); both rollups'
  slot and epoch lengths; 11 Inbox messages per network timed from their L1 block to the first L2 block whose
  message tree holds them (`node_getBlock`'s `l1ToL2MessageTree.nextAvailableLeafIndex`, by bisection).
- The keyless dRPC Aztec endpoints refuse `node_getL1ToL2MessageCheckpoint` and `node_getBlockHeader`, but serve
  `node_getBlock` and `node_getL1ToL2MessageMembershipWitness`. Publicnode's L1 RPCs prune logs past a few thousand
  blocks ("pruned history unavailable"): query at most about 5,000 blocks back.

## Consults

- Codex r1 (gpt-6.1-sol, high, fresh session): conditional approve. Adopted and rejected findings are in plan.md
  § Audit verdicts and the ledger (D3, D8, D9).
- Codex final (fresh session): approve; D3 rationale narrowed to production builds.
- Codex follow-up (same session): refuted the planner's countdown worry. The SDK's `awaitL2BlockCountdown` waits
  `depositL2Block + 3` L2 blocks (51 s testnet, 70 s mainnet), but app rows never carry `depositL2Block`
  (`useSend.ts:693`), so the app's Cross to Aztec phase is the inbox delay plus one 6 s poll. Verified in the tree.
