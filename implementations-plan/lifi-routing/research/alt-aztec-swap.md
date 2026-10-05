# Who swaps slice -> AZTEC: LI.FI probes

Live quotes are point-in-time (10 of 10 API requests used; 2 were repeats/tools). Tags: H/M/L confidence; [Qn] = request n below.
Requests: Q1 GET quote ETH->ETH USDC->AZTEC 5 USDC fromAddress=Diamond; Q2 GET /tools?chains=1; Q3 same as Q1 + `denyExchanges=bitget`; Q4/Q5 same as Q1 with 1 / 50 USDC; Q6 POST contractCalls Base USDC -> ETH AZTEC (single FeeJuicePortal call); Q7+Q8 (same body) POST contractCalls with 2 heterogeneous calls; Q9 `allowBridges=[across]`; Q10 `allowBridges=[relay]`.

## Q1 Same-chain USDC->AZTEC (5 USDC)
- Default pick: `bitget`. `transactionRequest.to` = Diamond; `approvalAddress` = Diamond. [Q1] H
- Outer selector `0x5fd9ae2e` = `swapTokensMultipleV3ERC20ToERC20(bytes32,string,string,address,uint256,(address,address,address,address,uint256,bytes,bool)[])` (verified `cast 4byte` + `cast decode-calldata`). Integrator `"lifi-api"`, receiver and minReceived are args (receiver = fromAddress here). H
- SwapData[0] = fee-collection pre-step (callTo `0xCE40449B773a3E6E5e769ADb4e567179d4828cbd`, inner `0x332d746b` forwardERC20Fees): 12,500 of 5,000,000 (0.25%) taken in USDC. SwapData[1] = the DEX leg on the net 4,987,500. H
- Bitget leg: callTo `0xBc1D9760bd6ca468CA9fB5Ff2CFbEAC35d86c973`, selector `0xd984396a` (no public signature). Its calldata carries a 65-byte signature and a word that decodes to a timestamp ~10 min after quote (0x6ac3c5d6 = quote time + ~10-12 min). Not verified as a deadline field; treat as an expiring signed quote. M. Bitget route = not deadline-free, and signature-bound = cannot be re-priced. gas est 103,960, limit 135,148, 5 USDC. [Q1]
- toAmount 290.098 AZTEC, toAmountMin 288.648 (0.5% default slippage). [Q1]
- Without Bitget [Q3]: `okx`; callTo `0x8feAB81D36E7576107D5dE0758c1b839Be31B4F6`, approveTo `0x40aA958dd87FC8305b97f2BA922CDdCa374bcD7f`, inner `0x0d5f0e3b` = `uniswapV3SwapTo(uint256 receiver,uint256 amount,uint256 minReturn,uint256[] pools)`: **no deadline param** (H, cast 4byte + decoded calldata; OKX DexRouter ABI recalled, M that no hidden expiry). Path decoded from pools: USDC -> WETH (Uni v3 0.01%, `0xe0554a47...39f`) -> AZTEC (Uni v3 1%, `0x7f926775...93c5`). toAmount 287.173, min 285.737, gas est 47,870 / limit 62,231 (implausibly low for 2 v3 hops; Diamond estimates for okx are unreliable). H for path, L for gas.
- So the Diamond's own function takes only a `minReceived`, no deadline; deadlines live inside the inner provider calldata and differ per exchange. H

## Q2 Exchange keys
`/tools?chains=1` exchanges: bitget, dodo, gluex, enso, 1inch, openocean, kyberswap, sushiswap, okx, merkle, fly, nordstern, lifiIntentsDex, smartDeposits. No `uniswap` or `lifidexaggregator` key on chain 1. [Q2] H. Only `denyExchanges=bitget` was tried (budget); a route exists with OKX at -1.0% toAmount vs Bitget (287.17 vs 290.10). `allowExchanges` by key (1inch, kyberswap, ...) NOT probed; 1inch/Kyber/0x-style routers normally embed deadlines in some entry points (L, unverified).

## Q3 Price impact and AZTEC liquidity
- 1 USDC -> 58.74 AZTEC (bitget); 5 USDC -> 58.02/USDC; 50 USDC -> 58.02/USDC (okx), toUSD 49.97 for 50.10 in. Slope between 5 and 50 USDC is flat: impact negligible at $1-$50 (quote-implied) [Q4, Q5, Q1]. H for quotes.
- Liquidity (cast, `publicnode`): AZTEC trades against WETH in the **Uniswap v3 1% pool** `0x7f9267759b90fb79bcb33258cab821a3495793c5` (liquidity 2.2e21, tick -119644; holds ~412.5k AZTEC + 0.67 WETH, total about $7k real TVL; ~$15k virtual depth at current tick). H. Other AZTEC pools are dust: v3 0.3% AZTEC/WETH `0x8722...0cD4` (~0.002 each side), v3 1% AZTEC/USDC `0x1894...E6d5` (10 wei AZTEC, 5.9k wei USDC). H. v4 pools not checked. 3 and 0.05% AZTEC/WETH do not exist.
- Implication: a $20 slice (~1,160 AZTEC) is ~0.13% of virtual reserves; fine. But TVL is only ~$7k, so a sandwich on a larger slice is cheap; a tight `minAmountOut` matters. Fee tier means ~1% LP fee is baked in. M.

## Q4 Fuel-only contractCalls (Base USDC -> AZTEC -> FeeJuicePortal.depositToAztecPublic)
Body: fromChain 8453, USDC, toChain 1, toToken AZTEC, `toAmount` 100e18, one call `{fromTokenAddress: AZTEC, fromAmount: 100e18, toContractAddress: portal, toContractGasLimit 200000, toApprovalAddress: portal, data 0x284b5dc6...}`. [Q6]
- Route produced. Steps: feeCollection (Base) -> `bitget` swap USDC->ETH (Base) -> `stargateV2` ETH Base->ETH Ethereum -> `bitget` swap ETH->AZTEC on Ethereum -> `custom` call. So LI.FI DOES swap to AZTEC on the destination before the call, bridge = Stargate V2 native-ETH with compose. H
- Cost for 1.76 USDC in (100 AZTEC out ~ $1.72): LI.FI fixed fee $0.0044 (0.25%), **LayerZero native fee $5.73 (0.00213 ETH)** , source gas est 1,350,159 ($0.02). ETA 125 s. Fixed ~$5.7 messaging cost dominates any small fuel send. H (quote), M for stability.
- Destination swap payload is built at quote time, so same expiring-quote risk as Q1 applies to the 2nd bitget leg. M.

## Q5 Heterogeneous calls
Accepted, not rejected [Q7/Q8]. Two calls (AZTEC 100e18 to portal; USDC 48 to Diamond), toToken USDC, toAmount 50 USDC. Result: route feeCollection -> stargateV2 USDC->USDC -> custom -> custom. **No swap step to AZTEC.** Both custom steps are labelled with fromAmount 50,250,000 (USDC units); the AZTEC call is unfunded. LZ fee $5.11. H for observation; the response looks wrong rather than a split, so do NOT rely on it (a mixed-token multicall is not modelled). Conclusion: LI.FI cannot do "slice to AZTEC, rest as USDC" in one route. M.

## Q6 Across / Relay with a contract call
`allowBridges=[across]` and `[relay]`, Base USDC 50 -> ETH USDC with a Diamond dummy call, gasLimit 150000: both `code 1002 "No available quotes"` (empty filteredOut/failed). [Q9, Q10] H. Only Stargate V2 (compose) produced contract-call routes in this probe (Q6, Q7, default bridge). Across/Relay unavailable for contractCalls today.

## Q7 Docs
- `https://docs.li.fi/guides/intermediate-tokens`: "If that destination swap can't be executed safely (... slippage ... or current liquidity), we stop at the bridged token and return a `DONE/PARTIAL` status instead of forcing a bad trade"; user receives the bridged asset. H
- `https://docs.li.fi/agents/workflows/partial-completion`: "A PARTIAL completion occurs when a cross-chain transfer succeeds but the user receives a different token than requested. This typically happens when the destination swap fails but the bridge succeeds." H
- Status page `https://docs.li.fi/introduction/user-flows-and-examples/status-tracking`: PARTIAL "common for across, hop, stargate, amarok"; REFUNDED "Tokens were refunded"; FAILED substatuses incl. EXPIRED. Guide text: "the user is then automatically refunded on the destination chain, typically in the bridged asset". H
- Contract-call API ref `https://docs.li.fi/api-reference/perform-multiple-contract-calls-across-blockchains-beta`: `toContractGasLimit` "Incorrect values may cause the interaction to fail"; examples carry a `toFallbackAddress`. Docs I fetched give NO statement about calldata validity windows/deadlines for destination swaps. H that I found none; unknown whether they exist.

## Q8 Gas sizing
- Same-chain quotes (Diamond tx, incl. fee-collection and DEX): bitget est 103,960 (limit 135k) @5 USDC, 85,730 (limit 111k) @1 USDC; okx est 47,870/107,230 (limit 62k/139k) @5/50 USDC. Estimates are internally inconsistent; real 2-hop v3 through the Diamond ~170-250k from experience. L-M.
- Suggested `toContractGasLimit` (sum): pull 60k + swap 250k + FeeJuicePortal deposit ~100k + token-portal deposit 120k = ~530k; first-time createPortal +350k = ~880k. Fuel-only: LI.FI's own contractCall used 200k limit for the portal deposit in the example; real cost of `depositToAztecPublic` (ERC20 transferFrom + Inbox sendL2Message) not measured here. L; validate on a fork.

## Q9 Alternatives (brief)
(a) LI.FI swaps to AZTEC itself (Q4): works for a fuel-only send, but costs ~$5.7 LZ fee, no split with USDC (Q5), swap payload expires. Poor for a mixed deposit. M.
(b) Router executes LI.FI same-chain calldata (Q1): needs approval to Diamond; calldata is fresh only for the quote window; Bitget path signature/expiry-bound, OKX `uniswapV3SwapTo` has no deadline but a stale `minReturn`. Router must verify `amountOut >= floor` itself and treat a revert as "skip fuel, deposit full amount" (or refund). Keep `to == Diamond` and selector allowlist, don't let the calldata choose receiver. M.
(c) Deliver ETH, swap ETH->AZTEC: best path is a direct on-chain v3 call. AZTEC liquidity is only the WETH/AZTEC 1% pool (~$7k), so ETH->AZTEC with our own Uniswap v3 `exactInputSingle` (fee 10000, `amountOutMinimum` from a fresh on-chain price + `deadline = block.timestamp`-style) is deterministic, deadline-free by design, and avoids a third-party calldata expiry; the repo's existing UniswapFuelSwap is the same idea. Cost: USDC->WETH hop 0.01% pool (`0xe0554a47...`, ~$3.6M USDC side). M-H (pool facts H; fit with existing contract not checked).
(d) Other: a user-side Aztec swap/Fee Juice acquisition was not researched; Aztec Fee Juice is bridge-only (FeeJuicePortal), no L2-side purchase found in this probe. Unknown.
