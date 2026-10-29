# mainnet-1 phase 2: the Drip deploy on mainnet (arc a2)

## Attempts

- **Preconditions.** `main` after #29, #32 and #33: C1 (the 6.0 identity) and C2 (`fjPerTx` and its calibration
  step) both hold.
- **The claim-and-deploy shape.** The plan named the canary's `--fresh-selfpay` claim. An archived lesson shows the
  embedded wallet cannot send from an undeployed account, so the deploy uses aztec.js's `DeployAccountMethod` from
  `NO_FROM` with `FeeJuicePaymentMethodWithClaim` (D11). A sandbox probe simulated it: 742,498 L2 and 864 DA gas.
  A sponsored account deploy uses 3,488 DA, so the sponsor, not the account, carries most of that DA.
- **The scan's start block.** The keyless publicnode endpoint refuses archive reads; `eth.drpc.org` answers them,
  so a binary search on `eth_getCode` found the portal's first block, 26,160,102, the rollup's too. That endpoint
  caps `eth_getLogs` at 10,000 blocks, so the scan reads in 10,000-block windows.
- **Worktree setup.** The sandbox needs `contracts/bridge/evm/lib`: the pinned `forge install --no-git` lines from
  `.github/actions/setup-forge/action.yml`, then `gen-remappings.ts`. After merging `origin/main`, `bun install`
  again, or `typecheck:all` fails on the new workspace's missing `tsc`.
- **Integration test, first run.** Funding, both kills and the resume worked; the assertion failed because the
  sandbox already publishes the Dripper and Token classes (its fixture deploys them), so the Dripper send cost less
  than the account's deploy and the bootstrap funding covered it. Sized the bootstrap at 1.05× the claim's limit and
  asserted no deposit and work left, rather than an unchanged balance. Second run green, 59 s on an attached
  sandbox. On mainnet the classes are unpublished, so the first sends there also publish them, which only aztec.js's
  own class check exercises.
- **viem caches the block number.** `getBlockNumber()` reuses its answer for about 4 s, so the full suite's first
  run read the funder's nonce at a block before its own mint and refused as "in flight". The scan reads it with
  `cacheTime: 0`.
- **Codex round 1 and the Opus review.** Both verified and fixed as § Audit verdicts records. The 2× claim headroom
  moved the bootstrap to twice the claim-and-deploy limit; the catalog still runs short (the Dripper and SIGNAL
  deploy, NOISE stops), so the top-up and resume steps are unchanged. The margin's refusal runs with the chain's
  whole height as the margin, so the L1 blocks the sequencer mines during the run cannot carry the scanned block
  past the funder's transactions. Green on an attached sandbox, 66 s.
