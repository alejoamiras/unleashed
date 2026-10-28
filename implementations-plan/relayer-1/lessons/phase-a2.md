# Arc a2 — pin the dedicated relayer

- `TESTNET_FILLER` moved from the canary to the relayer's key. `live-intent.test.ts` had pinned it equal to the
  canary; it now pins the opposite, that the filler is neither the canary nor a deploy signer.
- The sandbox impersonates the relayer a deposit names, so the cross-chain e2e follows the constant with no edit;
  `fill-testnet.ts` pins the canary through `PLAN_PINNED_CANARY_SIGNERS`, not `TESTNET_FILLER`.
- A fresh worktree's `e2e:tools` needs `lib/lifi-contracts` (the README's pinned `forge install --no-git` line and its
  cleanup) and the Chromium headless shell its `@playwright/test` pins (1.63.0 → build 1243); with the host's
  browser directory outside the lane's write boundary, `PLAYWRIGHT_BROWSERS_PATH` pointed at the lane's scratch.
- `bun run e2e:tools -- specs/deposit-crosschain.spec.ts` at retry 0: 5 passed in 12.5 min.
