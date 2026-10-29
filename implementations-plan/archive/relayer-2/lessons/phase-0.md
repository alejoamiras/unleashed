# relayer-2 phase 0: recon and consults

- Reusing the sdk's `firstBlockAfter` in the Worker: an esbuild bundle of `import { firstBlockAfter } from
  "@unleashed/sdk/internal"` fails (`Could not resolve "tty"`, colorette); `sideEffects: false` does not help, since
  resolution precedes tree-shaking. Dead end; the relayer gets its own search (plan D3).
- `sepolia.base.org` answers `-32614 eth_getLogs is limited to a 200 range` to every range from 500 up; PublicNode
  Base Sepolia serves up to 50,000 (`-32701 exceed maximum block range: 50000` above).
- A read-only run of the proposed scan on PublicNode: 39,001-block window, 56 source reads, 1.9 s.
- Codex round 1 (session `01a188e1`, gpt-6.1-sol, high): conditional approve. Accepted all five: anchor the window on
  Sepolia's head time (removes the clock-skew inference), race the read-only scan against 45 s (viem's 10 s timeout ×
  3 retries under `retried`'s 10 attempts can hold one read for minutes), clamp the lagged head at 0, a boundary
  table in the window test, and narrower lying-RPC and success claims.
- Codex final pass (fresh session `01a188e8`): conditional approve. Its in-memory reproducer showed a scan abandoned by
  a timeout race keeps reading; accepted: refuse each source read past the deadline. Also accepted: budget wording in
  logical reads and HTTP attempts, a stronger timeout test, I2 qualified. Resumed: **approve**.
- ORCHY-STEER added ask34 (15 s cadence). Codex audit of the revision (fresh session `01a188f9`): reject. It traced
  two fill-path cases where "never overlap / never a second pending transaction" fails: a send stalled between
  approval and fill meets the next run (known limit #36), and a 180 s receipt timeout revokes while the approval may
  be pending. Both went to `OWNER-ASKS.md` §1 (ship A: accept as known limits). Accepted: a full rescan each pass
  (no cross-pass state), the late gate and `pause` before each try, restock inside the minute. Resumed: conditional
  approve (race `pause` to the cutoff, bound the restock, drop missed slots); resumed again: **approve**.
- A send cannot be bounded from the relayer: `waitForTransactionReceipt` waits 180 s by default, and a timeout there
  makes `sendFill` revoke while the approval may still be pending. Bound the start of a send, never its length.
