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
6. Integration: `validateTokenBlock` now reads the factory registration through the pinned Ethereum reader (D49),
   and the cells no longer move the wallet back before the claim. `deposit-crosschain.spec.ts` alone: 5 passed.
7. The 98 `unleashed-wallet-*` stores in `/dev/shm` (about 1.7 GB) were `wallet-store.ts` stores that live scripts
   killed before their cleanup left behind. No process held any of them (`lsof +D /dev/shm`); those older than an
   hour were removed, which freed the tmpfs.

## Open

- **Resolved: the claim needed the wallet back on Ethereum.** The claim's token check reads through the pinned
  Ethereum reader now (D49).
- **A killed live script leaves its wallet store in `/dev/shm`.** `wallet-store.ts` removes its store only on a
  clean exit; a reaper of unheld stores at start, as the e2e runner has for its sandboxes, is a follow-up.
- **Decoder refusal before signing has no browser path** (D49). Off mainnet the route rides self-built fixed terms,
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

## Arc 4 review fixes

Four review findings on the cross-chain send, each verified against the code before it was fixed.

1. **Discovery stopped before the deposit was final.** An L1→L2 message hash includes its leaf index, so a reorg
   that re-includes the fill at another leaf moves every fact a claim is built from, and the claim waits on
   `l1ToL2MessageReadiness` for a hash that never arrives. `discoveryPatch` now sets the optional
   `route.depositFinal` once the deposit's block is at or below Ethereum's finalized head, clears it with the
   deposit, and keeps a final deposit's facts against later reads; the schema-4 validator accepts only `true`,
   never beside an outcome. `needsWatch` keeps a deposited record watched until then, so a reload resumes it.
   The claim still starts at the first deposit. A round that moves the deposit drops the cached claim material
   and starts the claim again; a claim already waiting in its checkpoint gate or simulate loop re-reads the
   stored record every poll and starts over once it moved. Cached material naming another leaf is never used,
   even when another tab moved the deposit. The v3 envelope stays until the deposit is final and is re-sealed
   exact then, from the in-memory key or at the next unseal; a claim that completes first leaves it on a
   finished record.
2. **A refused deposit discarded a live approval.** Approval hashes are journaled as the wallet returns them,
   before their receipts. A send that ends with nothing bridged but an approval journaled (the deposit refused,
   the approval's receipt lost, an expiry or account switch caught before the deposit) ends `not-sent` and final
   instead of being discarded, so its Activity card shows `LeftoverApproval`. Only drawn states show it: the
   wizard's not-sent outcome panel replaces the return to the review, and the Activity card reads "Not sent"
   with the revoke. Their copy says the source chain rejected or reverted the send, which is untrue of a wallet
   decline; that wording is the owner's call and was left as drawn.
3. **The account check compared captured values.** `CrossChainWallet.liveAccount` asks the wallet
   (`eth_accounts` through viem's `getAddresses`, which never prompts), and the send compares it with the
   route's sender right before the seal's message, each approval, the batch and the deposit. `sendCrossChain`
   runs inside `withOperation`, as Ethereum-origin sends do.
4. **The route's TTL was checked at entry only.** `ROUTE_TTL_MS` is checked again right before each approval,
   the batch and the deposit; a confirmed approval stays revocable through fix 2.

### Attempts

1. `git fetch` of the parent branch hung on SSH; the branch was cut from the commit the brief named, which the
   shared object store already held.
2. A fresh worktree has no `contracts/bridge/evm/{lib,out,cache,out-lifi,cache-lifi}`. They were copied from the
   parent worktree, as `lessons.md` allows. Without them bridge-core skips its artifact-dependent tests
   (27 skipped instead of 11), which reads as green.
3. Each new test was run against its fix removed: the claim restart (claim built once), the stale-material
   guard (the restarted claim sealed leaf 7), and the per-signature account and TTL checks (the deposit sent).

### Open

- `plan.md`'s Journal schema 4 block does not name `route.depositFinal` yet.
- The not-sent copy for a wallet decline after an approval (fix 2) needs the owner's wording or approval.
- `LeftoverApproval` reads the allowance once per mount: an approval whose receipt was lost and that lands
  later offers its revoke only when the card mounts again.

### Gate

Run on the fixed branch's head, with the forge outputs in place:

- `bun run lint`: Biome checked 621 files with no fixes applied, and the complexity baseline held;
  `bun run typecheck:all` exited 0 for design, bridge-core and tools.
- `bun run test:all`: design 242 passed, bridge-core 704 passed and 11 skipped, tools 1752 passed.
- `bun run e2e:tools -- specs/deposit-crosschain.spec.ts`: 5 passed (cells 50–54), playwright exit 0.
- `bun run e2e:tools -- specs/l1-wallet.spec.ts`: 5 passed (cells 26, 26d, 26e), playwright exit 0.
