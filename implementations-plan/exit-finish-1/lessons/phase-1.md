# exit-finish-1: phase 1 (a1) log

- viem 2.57.1's `waitForTransactionReceipt` reports the awaited transaction as its own `repriced` replacement when a
  receipt read lags the block that holds it (`onReplaced` with `transaction.hash === replacedTransaction.hash`).
  Judge a replacement by the receipt's hash, never by the callback alone. Reproduced over a scripted EIP-1193 transport.
- `useL1Wallet.chainChanges` counts only while `connect()`'s listener is attached; a disconnect, or a page that never
  connected, hears no switch. A count meant to prove "one chain throughout" must treat a disconnect as a change.
- A scripted EIP-1193 transport (`createPublicClient({ transport: custom({ request }) })`) answering
  `eth_getTransactionByHash`, `eth_getTransactionReceipt`, `eth_getBlockByNumber` and `eth_blockNumber` drives viem's
  real wait, replacements included, in milliseconds; fake timers cover the give-up path.
- New worktree: forge `lib/` copied from another lane's worktree with `rsync` excluding agent instruction and env files,
  instead of `forge install` (lessons.md's first entry).
