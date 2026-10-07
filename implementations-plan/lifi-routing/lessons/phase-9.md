# Phase 9: Browser e2e for the multi-chain flow

**Verdict: built.** `deposit-crosschain.spec.ts` (cells 50–54) passes against the sandbox. The decoder-refusal
cell has no browser path and stays covered by unit tests (see Open). The gate results are in the Gate section.

## Facts the next phases rely on

- **The local build alone routes.** `loadLocalRun` routes the source anvil's token into the manifest's rail token
  and hands the target the sandbox's LI.FI stand-ins. `network.ts` books them through `registerSandboxLifi`, which
  accepts chains 31337 and 31338 only and never shadows a `LIFI_BOOK` chain. What the sandbox does not deploy
  (the Ethereum-side Diamond, the fee forwarder, the code hashes) is the zero value, which every check refuses.
- **Exclusivity is real in the sandbox.** `TestSpokePool.fillRelay` reverts `NotExclusiveRelayer` for any
  sender but the named relayer until `exclusivityDeadline`. Fixed terms set `exclusivityParameter = fillDeadline`
  and name `TESTNET_FILLER`, so nobody else may ever fill a testnet send. The relay loop fills as the relayer a
  deposit names: `anvil_impersonateAccount` + `anvil_setBalance` on L1, the output token minted to it.
- **Two clocks.** The local network warps the L1 anvil to each L2 block's slot, so it runs hours ahead of the
  source anvil, which keeps wall time. Fixed terms set `fillDeadline` from the source head plus 7200 s, which
  without levelling falls behind Ethereum's clock. `syncSourceClock` mines one source block at L1's latest
  timestamp before a quote. Expiry is reached by forcing L2 blocks until L1's finalized timestamp passes the
  deadline, never by warping L1 directly: cell 54 takes about five minutes.
- **`starve-gas` never reaches the receiver's recovery.** Under the sandbox's rules a fill starved to 250k gas
  reverts whole, so the deposit stays unfilled and expires on the source chain. The delivered-to-wallet outcome
  comes from pausing deposits on the factory before the fill: the router reverts `DepositsPaused`,
  `ReceiverAcrossV4` catches it and pays the user's Ethereum address.
- **The cross-chain review is its own step.** It renders `sendXcReview`, never `sendStepReview`;
  `reviewDeposit` and `goToReview` take the step to wait for.
- **viem decodes calldata addresses checksummed.** Compare decoded arguments against `getAddress(...)`.
- **The wallet stays on the source chain after a send, and the claim refuses there.** The claim lane's
  `validateTokenBlock` asserts and reads Ethereum through the wallet's provider, so the stepper's "Cross to
  Aztec" fails with the wrong-chain copy. `L1WalletPanel` offers no switch on a source chain by design. The
  claiming cells move the wallet back with `setChainId`, as a user would in the wallet.
- **The L1 wallet fixture speaks EIP-5792.** `wallet_getCapabilities` answers `{ [hexChainId]: { atomic: {
  status } } }`; `wallet_sendCalls` sends the calls one by one on the batch's chain and answers `{ id }`;
  `wallet_getCallsStatus` answers 100 while receipts are withheld, then 200 with hex receipts.
- **`tokens.spec` cell 34 reads Ethereum's rows only.** The source chain's routed row and each chain's native
  coin sit in the same list.

## Attempts

1. `forge install --no-git` was refused by the worktree guard, which reads it as a git operation. The library
   was copied in instead, as `lessons.md` allows.
2. The first sandbox boot died with LMDB `mdb_txn_commit: 5 - Input/output error` in `/dev/shm`: about 390 MB
   free, the rest held by orphaned `unleashed-wallet-*` stores this run did not own. A second boot went through.
   Nothing was deleted.
3. Cell 50 waited for `sendStepReview` after CONTINUE; the cross-chain review has its own testid.
4. Cell 50 reached "Cross to Aztec failed": the wrong-chain refusal above. The cell now moves the wallet back
   once the send is on the rail.
5. Cell 50 compared a decoded spender with a lower-case address. After that, cells 50–54 passed on first run.

## Open

- **The claim of a cross-chain send needs the wallet back on Ethereum, and the app does not ask for it.** A
  user whose wallet stays on the source chain sees the claim fail with "Switch networks and try again" and no
  switch to press. Moving the claim lane's Ethereum reads to `readClientFor(NETWORK.l1ChainId)` would remove
  the dependency; it changes which RPC vouches for a token block, so it is a decision, not a test fix.
- **Decoder refusal before signing has no browser path.** Off mainnet the route rides self-built fixed terms,
  so the bytes `verifyRoute` checks are the app's own and no venue answer can be tampered with from the
  harness. Unit tests cover it: `useCrossChainRoute.test.ts` ("never offers bytes the decoder refuses") and
  `crosschain-deposit-flow.test.ts` ("refuses a stale, tampered or wrong-chain route before journaling").

## Gate

- `bun run lint && bun run typecheck:all`: Biome checked 621 files, no errors (2 infos, both outside this
  phase's files); the three workspaces typecheck with exit 0.
- `bun run test:all`: design 242 passed; bridge-core 702 passed, 11 skipped; tools 1746 passed. A first run
  timed out one `AddressesView.test.ts` case at 5 s under a load average near 88; it passed alone and on the
  rerun.
- `bun run e2e:tools` from a fresh sandbox: 75 passed, Playwright exit 0. The egress fixture is automatic and
  asserts its blocked list is empty at every test's teardown, so a green run is an empty record.
- The two-worktree concurrent run is the coordinator's.
