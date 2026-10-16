# Research (lead): LI.FI API quote shapes for the fuel swap and the cross-chain call

Lead-planner round. 15 unauthenticated li.quest requests; calldata decoded offline with `cast` against `lifinance/contracts` signatures. Live quotes are point-in-time. Confidence **H** unless marked.

Gotchas: Base USDC is `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`. The API rejects placeholder addresses such as `0x2222…2222` (`code 1011`), so fixtures and probes must use real-looking addresses.

## `/v1/chains`

| Chain | diamond | permit2 | permit2Proxy |
|---|---|---|---|
| 1, 8453, 42161, 10 | `0x1231DEB6…4EaE` | canonical | `0x89c6340B1a1f4b25D36cd8B063D49045caF3f818` |
| 11155111 | `0xeCeC3970…81F5` | canonical | `0xBC2fEd259E6868c85987EDe6bCD2b1C3B9b3C4Bd` |
| 84532 | `0x816Fc6Ee…1770` | canonical | `0xC55CB7741da5519f0AdF5f13E9609311e7097A24` |

The API's addresses agree with `deployments/*.json` (a second, independent source for `verify-l1`).

## Same-chain quotes into AZTEC on Ethereum (`/v1/quote`, `fromChain=toChain=1`, `slippage=0.01`)

| | USDC 5e6 | WETH 2e15 | ETH 2e15 |
|---|---|---|---|
| tool | sushiswap (`snwap`) | nordstern (opaque packed calldata) | nordstern |
| toAmount / toAmountMin (AZTEC) | 286.27 / 283.41 | 309.91 / 306.81 | same |
| `tx.to` | diamond | diamond | diamond |
| selector | `0x5fd9ae2e` `swapTokensMultipleV3ERC20ToERC20` | `0x5fd9ae2e` | `0x736eac0b` (NativeToERC20, `value` = amount) |
| gasLimit | ~582k | ~365k | ~369k |
| approvalAddress | diamond | diamond | — |

- Top-level args: `_transactionId` random per quote; `_integrator = "lifi-api"`; `_receiver` = the request's `toAddress` exactly; `_minAmountOut` = `toAmountMin` exactly; `fromAddress` is not embedded (it only matters as the `msg.sender` that is pulled from).
- SwapData[0] = fee collection: FeeCollector `0xCE40449B773a3E6E5e769ADb4e567179d4828cbd` `forwardERC20Fees` (`0x332d746b`), `fromAmount` = the full input, `requiresDeposit = true`, 0.25 %. SwapData[1] = the DEX call, `fromAmount` = input − fee, recipient = the diamond (which pays `_receiver`).
- `allowExchanges=1inch` → same outer shape, `callTo` = AggregationRouterV6 `0x111111125421cA6dc452d289314280a0f8842A65` (`swap` `0x07ed2379`); `allowExchanges=uniswap` → "No available quotes" (key probably not `uniswap`). The DEX behind the facet changes per quote: our contract must never hard-code it.
- Deadlines (M): Sushi `snwap` and 1inch V6 `swap` carry no deadline parameter; Nordstern's packed format was not decoded. The only explicit expiry seen was an RFQ (bitget) order with a ~10-minute deadline (D3 below).

## Cross-chain contract calls (`POST /v1/quote/contractCalls`, Base USDC → Ethereum)

- **D1 (one call, toAmount 100 USDC):** route **stargateV2** (Fast); steps feeCollection → cross → custom. `tx.to` = diamond, `0xa6010a66` `swapAndStartBridgeTokensViaStargate(BridgeData, SwapData[], StargateData)`; source SwapData[] = only the fee collection; `BridgeData.receiver` = the user (fromAddress), `hasSourceSwaps = true`, `hasDestinationCall = true`, `minAmount` 101.07; `sendParams.to` = ReceiverStargateV2 `0xB539…4BDC`, `dstEid` 30101, `amountLD` 101.07, `minAmountLD` 100.500001; `composeMsg = abi.encode(txId, SwapData[], receiver)` with SwapData[0] = {callTo = approveTo = our contract, Ethereum USDC, **`fromAmount = minAmountLD`**, our calldata verbatim, `requiresDeposit = true`} and `receiver` = our `toFallbackAddress`. `estimate.toAmount`/`toAmountMin` are `"0"` in contractCalls responses; fees: LI.FI fixed 0.254 USD, LayerZero native 4.65 USD (paid as `tx.value`); ETA 125 s.
- **D2 (two calls, USDC then AZTEC):** accepted silently and **wrong**: no destination swap; both SwapData target our contract with the same `fromAmount` (minAmountLD), the AZTEC one included. Multi-token contract calls cannot deliver a token leg plus an AZTEC leg.
- **D3 (one call, `fromTokenAddress = AZTEC`):** accepted: source swap USDC → ETH (bitget), bridge ETH (stargateV2), destination SwapData[0] = bitget ETH → AZTEC executed by the Executor (signed RFQ order, **deadline ≈ quote time + 10 min**), SwapData[1] = our call with AZTEC. One token only, and deadline-bearing.
- **D4:** `allowBridges: ["across"]` (Base → Ethereum) → "No available quotes"; Arbitrum USDC default → stargateV2. Mainnet contract calls into Ethereum route **only via Stargate V2** today.

## Base USDC → Ethereum AZTEC, no call (`/v1/quote`)

Route relaydepository (Relay; source 1inch swap), 6 s; 5 USDC → 154.8 AZTEC versus 286 AZTEC same-chain: a plain cross-chain buy loses about half to Relay's gas and service fee at this size.

## Consequences for the design

1. The fuel swap must run **inside our contract** from a separate same-chain quote (`fromAddress = toAddress = our contract`): target = diamond, selectors `0x5fd9ae2e` (and `0x4666fc80` for robustness), approve exactly the input, measure the AZTEC delta, tolerate returned input dust.
2. Our cross-chain call carries no amount the bridge honours: the Executor approves us `max` and holds the delivered amount (≥ `minAmountLD`), so "deposit what arrived" means pulling the caller's balance, never trusting `fromAmount`.
3. The same-chain quote should be restricted to deadline-free exchanges for the cross-chain path (Stargate ETA ~2 min); the plan verifies this on a fork rather than trusting the absence of a parameter.
4. The source-tx decoder must accept the fee-collection SwapData (pinned FeeCollector, sending = receiving = the bridged token, fee ≤ a disclosed cap) and nothing else as a "source swap".
