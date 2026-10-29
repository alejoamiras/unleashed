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
