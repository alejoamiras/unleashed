# Phase 2: Mainnet forks and the dual-fork replay

**Verdict: done.** LI.FI's real destination stack delivers into `DepositRouter` on mainnet forks over both rails.
I3 settles on nordstern. D41 makes mainnet cross-chain sources USDC-only, and D42 sets `maxPull` slack at 1.5 %.
Three agents wrote the suites in parallel on shared bases (`test/lifi/LifiForkBase.sol`,
`test/lifi/MainnetLifiFork.sol`). The parent owns recording.

## Facts the next phases rely on

- **li.quest, keyless.**
  - Same-chain quotes at the fixture router: USDC → AZTEC with `denyExchanges=bitget` routes through nordstern
    (two Uniswap V4 pools: ETH/USDC, then ETH/AZTEC fee 500 with a hook). `allowExchanges=bitget` is a signed RFQ.
  - Both use `swapTokensMultipleV3ERC20ToERC20` (`0x5fd9ae2e`) with a FeeCollector step first.
  - A 10 USDC slice (the largest expected) moved −0.32 % in USD terms, LI.FI's 0.25 % fee included. The fork
    delivered 578.189 AZTEC against a `toAmount` of 578.510 (99.94 %).
- **Contract calls into Ethereum route only through Stargate V2.**
  - The quote's `extraOptions` set lzCompose gas to `toContractGasLimit` + 300,000 and lzReceive gas to 141,028.
  - The source sends `amountSentLD` 1.09 % above `toAmount`. Stargate's expected delivery `amountLD` is 1.01 % above
    it, and `minAmountLD` is 0.5 % above it (D42).
  - LI.FI's fallback receiver is the user, and `BridgeData.integrator` is empty on the keyless tier.
- **No WETH contract call from Arbitrum.** LI.FI refuses it: Stargate delivers native ETH and the destination wrap
  needs a signature (D41).
- **I3.**
  - nordstern survives `vm.warp(+3 × 125 s)`.
  - bitget's signed order carries its expiry as word 9 of the venue call, 648 s after the quote. At expiry + 1 the
    venue reverts `DeadlineExpired()` and the fill recovers to the user.
- **nordstern has its own inner minimum**, a 16-byte value at byte 42 of its call, equal to `toAmountMin` + 1.
  - With the facet's `_minAmountOut` and the router floor both lowered, a 16 ETH buy in the ETH/AZTEC pool pushed
    the output below nordstern's minimum but well above our floor.
  - The venue reverted ("Insufficient output") and the fill recovered. So an inner venue minimum stricter than the
    router's floor fails safe.
- **Gas (I7).**
  - The worst destination shape costs 673,561 cold at Ethereum block 26,128,734, against the 530k estimate.
    `LIFI_TO_CONTRACT_GAS_LIMIT` is 1,000,000, which keeps 1.3× headroom.
  - The testnet router step inside a fill costs 381k (public), 381k (private) and 285k (fuel-only), out of about
    599k for the whole `fillRelay`.
- **Stargate compose.**
  - The quote's lzCompose gas is `toContractGasLimit` + 300,000, and ReceiverStargateV2's `recoverGas` is 100,000.
  - The worst shape completes from 902,526 gas, which leaves `LIFI_MIN_COMPOSE_GAS` (1.3M) 44 % headroom.
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
   The recorder now keeps a 404's per-path reasons as evidence (`crossChain.arbitrumWeth.available = false`).
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
