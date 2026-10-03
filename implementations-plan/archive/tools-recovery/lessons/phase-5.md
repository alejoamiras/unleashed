# Phase 5 — the L2 finder (`exit-attach.ts`)

Arc 3 (rebased onto the arc-2 fixes). Gate:
`bun run --cwd apps/tools test -- src/composables/exit-attach` 8/8 green;
`bun run --cwd packages/bridge-core test -- src/journal` (`rekeyRecordWhen`, landed in arc 1) green;
typecheck exit 0; `bun run lint` exit 0.

## What landed

- `exitMessageHash(rec, { chainId, rollupVersion })`: `computeL2ToL1MessageHash` over the hub as
  sender, the token's portal clone as recipient, `withdrawContentHash(recipientL1, amount, ZERO_L1)`
  (the portal's `withdraw` takes no caller), this target's rollup version and chain.
- `findExitTx(rec, node, taken, options)` over a narrow node surface (`getNodeInfo`, `getBlockNumber`,
  `getBlocks` with bodies, `getTxEffect`): the node's identity asserted against the options and the
  record; the window start by binary search over block timestamps (capped); a chunked scan that
  requires every block and its body (a short answer or a missing body ⇒ `"incomplete"`); only
  `l2ToL1Msgs[0]` counts; `taken` hashes excluded; one / ambiguous / none; one read budget (count,
  deadline, transport failures). `findVerifiedExitTx` re-reads the found transaction's first message
  before the attach re-keys; `verifyExitTx` is the re-read.
- Tests with a fake node (36 s blocks): the hash vector and its inputs, index-zero-only matching, the
  window, `taken`, ambiguous / none, identity mismatches (node chain, node version, record chain), the
  cap, pruned history, failed / hanging / over-budget reads, the candidate cap, the re-read.

## Lessons

- The node client's `getTxEffect` takes a parsed `TxHash`; the finder speaks strings, so the wiring
  in `useHubExit.ts` adapts (`TxHash.fromString`) rather than the finder importing node types.
- The found shape carries `messageHash` so the re-read needs no recomputation.
