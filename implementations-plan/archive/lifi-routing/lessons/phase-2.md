# Phase 2: Mainnet forks and the dual-fork replay

**Verdict: done.** LI.FI's real destination stack delivers into `DepositRouter` on mainnet forks over both rails.
I3 is settled: every deadline-free venue LI.FI picked survives the warp. D41 makes mainnet cross-chain sources
USDC-only, and D42 sets `maxPull` slack at 1.5 %. Three agents wrote the suites in parallel on shared bases
(`test/lifi/LifiForkBase.sol`, `test/lifi/MainnetLifiFork.sol`). The parent owns recording.

## Facts the next phases rely on

- **li.quest, keyless.**
  - Same-chain USDC → AZTEC quotes at the fixture router with `denyExchanges=bitget` route through whatever
    deadline-free venue LI.FI prefers that day. It was nordstern (two Uniswap V4 pools) at one recording and
    sushiswap at the next. `allowExchanges=bitget` is a signed RFQ.
  - Every fork property therefore derives the venue from the fixture and hard-codes no pool or byte offset.
  - Both use `swapTokensMultipleV3ERC20ToERC20` (`0x5fd9ae2e`) with a FeeCollector step first.
  - A 10 USDC slice (the largest expected) moved −0.32 % in USD terms, LI.FI's 0.25 % fee included. The fork
    delivered within 0.1 % of `toAmount`.
- **Contract calls into Ethereum route only through Stargate V2.**
  - The quote's `extraOptions` set lzCompose gas to `toContractGasLimit` + 300,000.
  - The source sends `amountSentLD` 1.09 % above `toAmount`. Stargate's expected delivery `amountLD` is 1.01 % above
    it, and `minAmountLD` is 0.5 % above it (D42).
  - LI.FI's fallback receiver is the user. `BridgeData.integrator` is whatever the request sends: the recorders
    send `LIFI_INTEGRATOR` (`unleashed`).
- **Arbitrum WETH (D41).**
  - At the first recording LI.FI refused the contract call (404: the destination wrap needs a signature).
  - At the next it quoted feeCollection → okx WETH→USDC on Arbitrum → Stargate → nordstern USDC→WETH on Ethereum
    → our call. That puts a destination swap before our step, which the decoder's one-step rule refuses.
  - USDC-only stands either way.
- **I3.**
  - nordstern and sushiswap both survive `vm.warp(+3 × 125 s)`.
  - bitget's signed order carries its expiry as word 9 of the venue call, about 645 s after the quote. At
    expiry + 1 the venue reverts `DeadlineExpired()` and the fill recovers to the user.
- **Venues carry their own inner minimum.** Each venue call holds exactly one 16-byte value between `toAmountMin`
  and `toAmount` (nordstern at byte 42, sushiswap at byte 148).
  - With the facet's `_minAmountOut` and the router floor lowered, a venue whose own minimum sits above what it
    delivers reverts first and the fill recovers whole.
  - An inner venue minimum stricter than the router's floor therefore fails safe.
- **Gas (I7).**
  - The worst destination shape costs 717,544 cold through sushiswap (Ethereum block 26,128,931) and 673,561
    through nordstern, against the 530k estimate.
  - `LIFI_TO_CONTRACT_GAS_LIMIT` is 1,000,000, which keeps 1.3× headroom.
  - The testnet router step inside a fill costs 381k (public), 381k (private) and 285k (fuel-only), out of about
    599k for the whole `fillRelay`.
- **Stargate compose.**
  - ReceiverStargateV2's `recoverGas` is 100,000.
  - The worst shape completes from 947,690 gas, which leaves `LIFI_MIN_COMPOSE_GAS` (1.3M) 37 % headroom.
  - A sweep from 100k to 1.3M never deposits partially: every budget either recovers the whole amount to the user
    or completes.
  - The gas is what LayerZero's executor passes to `EndpointV2.lzCompose`, not a transaction limit (moderate
    confidence).
  - `ComposeDelivered(address,address,bytes32,uint16)` has no indexed field, so discovery decodes the guid from
    the data.
  - Stargate's message is: type (1 byte), assetId (2), sendTo (32), amountSD (8), composeFrom = the Base Diamond
    (32), then the app message.
- **LI.FI marks the destination step `requiresDeposit: true`.** The Executor ignores the flag, so the Phase 4 decoder
  accepts either value.
- **With 1.5 % `maxPull` slack the router pulls Stargate's whole delivery** (101,005,024 against T = 100,000,000).
  Nothing is left for the Executor to forward to the user on Ethereum.
- **The deployed mainnet Inbox emits `MessageSent(uint256 indexed checkpoint, uint256 index, bytes32 indexed hash,
  bytes16 rollingHash)`.** That is not our artifacts' `IInbox` event, and the key sits in topic 2. Phase 4
  discovery must match the deployed shape per network.
- **Archive RPCs for replaying committed fixtures (keyless):**
  - Ethereum: `eth.drpc.org`.
  - Base: `base.drpc.org` or `mainnet.base.org`.
  - Sepolia fork state: `sepolia.gateway.tenderly.co`. Never use it for `getLogs`, which it truncates.

  PublicNode prunes after minutes, so the gate records and runs at once.

## Attempts

1. The first mainnet recording failed on the fifth call: LI.FI returned 404 for the Arbitrum WETH contract call.
   The recorder now keeps a 404's per-path reasons as evidence.
2. **Forge's `vm.recordLogs` keeps the logs of reverted frames; a chain's receipt drops them.**
   - The recovered rail receipts carried transfers that never happened: receiver → Executor, and Executor →
     router.
   - Fix: `_fillRecovered` re-runs the fill from a snapshot with the Executor reverting at entry. This is
     equivalent because ReceiverAcrossV4's `catch` ignores the reason.
   - It asserts both runs leave the same holdings and that the receipt is the recording minus one contiguous
     block.
   - Any recorder that writes a receipt must prove that no frame reverted (`LifiReplayFork` does it through
     `startStateDiffRecording`), or strip the reverted frames this way.
3. The re-record at 1.5 % slack failed the compose suite's setUp, which still assumed a forwarded surplus. The
   setUp now asserts the D42 property instead: `maxPull` covers the expected arrival.
4. **Gate.** `LIFI_LIVE=1 bun packages/bridge-core/scripts/lifi-fixtures.ts --run` exits 0 on fresh fixtures:
   - `LifiTestnetRailFork` 7, `LifiStargateComposeFork` 6, `LifiDestinationFork` 11, `LifiReplayFork` 2.
   - 26 passed, 0 failed, 0 skipped.

   RPCs: Ethereum `eth.drpc.org` and Base `mainnet.base.org`; the testnets on PublicNode.
5. Re-recording the mainnet quotes with the integrator turned up three changes:
   - LI.FI had switched the deadline-free venue to sushiswap, whose AZTEC hop is not a V4 pool. That broke the
     inner-minimum test's hard-coded ETH/AZTEC V4 buy.
   - The test now models the price move venue-agnostically: it raises the venue's own minimum one unit above its
     measured delivery while the delivery still clears the router floor.
   - The mainnet suites then passed 19/19 on the new fixtures.

## Arc 1 Codex loop

- **Round 1** (`gpt-6.1-sol`, `high`, over `main..HEAD`): no critical or high finding. It raised two material
  verification gaps and one comment, all verified against the code and accepted (D43):
  - the TS gas constants were pinned only through Solidity copies;
  - the mock refunded the one unit the real facet keeps as dust.

  The dust fix also changed one fuzz property and one halmos proof, which had modelled a whole-balance refund.
  - A Phase 4 agent found that the recorder never sent the integrator, so the mainnet fixtures were re-recorded
    with it (attempt 5).
- **Round 2** (resumed): no fund-risk defect. Two stale comments counted as material and were fixed: the
  inner-minimum helper's old NatSpec, and the recorder's claim that LI.FI never quotes Arbitrum WETH. Codex judged
  the venue-agnostic inner-minimum test a valid model of the boundary (`floor ≤ delivered < venue minimum`), and
  confirmed that the mutated word is sushiswap's minimum-output argument.
- **Round 3** (resumed): "No new material findings." The loop converged in three rounds.
