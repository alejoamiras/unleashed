# Phase 3 — the L1 finder (`deposit-reconcile.ts`)

Arc 2. Gate: `bun run --cwd apps/tools test -- src/composables/deposit-reconcile`
15/15 green; `bun run --cwd apps/tools typecheck` exit 0; `bun run lint` exit 0.

## What landed

- `findDepositTx(rec, l1, { chainId, router, … })` over a narrow viem surface (`getChainId`,
  `getBlockNumber`, `getBlock`, `getLogs` with ONE event, `getTransaction`, `getTransactionReceipt`):
  the chain assertion on both sides of the scan; the window start by binary search over block
  timestamps from `createdAt − slack` inside a capped range (a range whose oldest block is still
  at/after the target ⇒ `"incomplete"`); chunked `getLogs` on the intent's event, kept on the decoded
  secret hash(es); each candidate's calldata decoded and matched field by field (entrypoint by intent,
  token, portal, privacy, aztec recipient = zero for private, fuel recipient = recipient or the
  PrivateFPC, amounts incl. `totalAmount = amount + fuel`, `minFuelOutput`, both secret hashes); the
  receipt must be a success whose block hash the chain still agrees with. One read budget (count +
  wall-clock deadline via `Promise.race` + transport failures) ⇒ `"incomplete"`.
- Tests with a fake chain (12 s blocks; the fake's `getLogs` answers with the args it was given, one
  event name per call, as viem does): the window, `bridge` and `bridgeWithFuel` matches, a private
  deposit, the calldata rejections (token / portal / amount / recipient / entrypoint), foreign `to`,
  reverted, undecodable, ambiguous, gas-only, and every `"incomplete"` cause (cap, chain before /
  after / record, failed read, hanging read under fake timers, read budget, candidate cap, reorg).

## Lessons

- Block-time arithmetic in the fake: `createdAt` must be expressed in block seconds (12 s × block),
  or the slack lands the window at genesis and an "early" transaction is found too.
- The finder was drafted during the arc-1 boundary and stayed untracked until this branch existed;
  see phase-2 for the `git add <dir>` sweep it caused.
