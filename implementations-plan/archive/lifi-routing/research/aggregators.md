# Research: cross-chain providers for "any L2 → Ethereum + call → Aztec"

Round-1 research (15 read-only agents, live API probes, two fork suites). Confidence: **H** high, **M** moderate, **L** low.
Live probes are point-in-time; quotes and fees move.

## Verdict

| Provider | Destination call on Ethereum | Amount on arrival | Failure lands | Sepolia | Chosen role |
|---|---|---|---|---|---|
| **LI.FI** | Yes (`/v1/quote/contractCalls`, beta) | Fixed in calldata (surplus → `receiver`) or dynamic via Patcher / our adapter | Tokens to `toFallbackAddress` **on Ethereum** (never a source refund) | API: no contract-call quotes; its **contracts are deployed** on Sepolia + Base/Arb/OP Sepolia | **The single provider** |
| Across (direct) | Yes (`MulticallHandler`) | Fixed `outputAmount` at signing | No fallback → fill reverts → origin refund after `fillDeadline`; with fallback → tokens to fallback on Ethereum | Yes (routes + message simulation; ~8 USDC / 0.003 WETH liquidity caps) | Underlying rail; testnet bridge leg |
| Socket / Bungee | Yes (`IBungeeExecutor.executeData`) | Not fixed | Unclear | No testnets; old API 410, V3 needs key | Dropped |
| NEAR Intents (1Click) | **No** (plain transfer only) | `EXACT_OUTPUT` fixes it | Origin refund | None, no plans | Out (see deferred-designs.md) |
| CCTP v2 | Hook data carried, never executed by Circle | Standard exact; Fast minus fee | Message stays retryable | Yes | Not chosen |
| Stargate v2 | `lzCompose` (taxi only) | Bounded by `minAmountLD` | Compose retryable by anyone | Partial | Underlying rail (LI.FI's only contract-call route to Ethereum today) |
| CCIP | `ccipReceive` | Exact | Manual re-exec | Yes (CCIP-BnM only) | Not chosen |

## LI.FI — API (H unless noted)

- `POST https://li.quest/v1/quote/contractCalls` (documented as BETA): `contractCalls[]{fromAmount, fromTokenAddress, toContractAddress, toContractCallData, toContractGasLimit, toApprovalAddress?, toFallbackAddress?}`, top-level `toToken`, `toAmount`, `contractOutputsToken`, `allowBridges`/`denyBridges`, `allowDestinationCall`. Source: docs.li.fi API reference "perform multiple contract calls across blockchains (beta)".
- **The API does not simulate or allowlist the destination call.** Reverting calldata, an unknown target (`0x…DeaDBeef`) and an omitted `toApprovalAddress` all quoted identically; `stepSimulation` covers only the source tx. A destination revert is caught only on Ethereum.
- **Only Stargate V2 serves L2 → Ethereum contract calls.** Live: Base, Arbitrum and Optimism → Ethereum USDC + call all routed `stargateV2` (Base/Arb/OP ETA 125/78/70 s); `allowBridges=["across"]` and `["relay"]` → "No available quotes".
- **Any token in, any token out.** Live quotes with a call: AERO (Base) → USDC; USDC (Base) → LINK (swap on Ethereum before the call); AERO (Base) → AAVE (swap on both sides, bridged leg ETH); ARB (Arbitrum) → LINK. The bridged leg is always USDC/USDT/ETH; breadth comes from DEX swaps either side.
- **Fees are high and volatile.** LayerZero native fee for the same 100 USDC Base → Ethereum + 300k-gas call: $2.01, then $12.04 the next day at ~0.96 gwei L1. Composite routes quoted $5.90–$17.04 on $72–$101. LI.FI fixed fee ≈ 0.25%. No-key quotes work.
- **$AZTEC is routable.** `GET /v1/token?chain=1&token=0xa27ec…62d2` → AZTEC, 18 dec; `/v1/quote` 20 USDC → AZTEC on Ethereum: $19.96 out via an aggregator (`bitget`); Base USDC → Ethereum AZTEC (no call): `relaydepository` route, $18.08 out.
- Fixed-amount semantics seen live: the Stargate step's `toAmountMin` (100,500,001) becomes the Executor's `SwapData.fromAmount`; our calldata's own amount is whatever we wrote; the surplus (`toAmount − our amount`) is swept to `receiver` on Ethereum.
- Status: `GET /v1/status?txHash=` → `NOT_FOUND|INVALID|PENDING|DONE|FAILED`, substatus `COMPLETED|PARTIAL|REFUNDED…`, `receiving.txHash`. Status does **not** say whether the destination call succeeded (M); the authority is on-chain (our portal/adapter event vs `LiFiTransferRecovered`).
- Composer (on-chain VM) only calls protocols LI.FI onboarded; for our own contract, `contractCalls` is the path (M-H).
- LI.FI history: exploited ~2022 (~$600k) and July 2024 (~$10M, a newly added facet draining unlimited approvals) (M-H, from memory; verify before citing externally). Consequence: exact approvals only, never unlimited, and prefer LI.FI's Permit2Proxy.

## LI.FI — testnet (H)

- `/v1/chains` lists Ethereum Sepolia 11155111, Base Sepolia 84532, Arbitrum Sepolia 421614, OP Sepolia 11155420 (`mainnet:false`).
- Plain `/v1/quote` Base Sepolia USDC → Sepolia USDC works (tool `lifiIntents`; another probe also listed `across`, `smartDeposits`).
- `/v1/quote/contractCalls` Base Sepolia → Sepolia → 404 "No available quotes". `allowBridges=cctp|stargateV2` on testnet → same.
- `staging.li.quest` → 403 (needs LI.FI permission); `testnet.li.quest` → 404.
- `lifinance/contracts` has `deployments/sepolia.json`, `basesepolia.json`, `arbitrumsepolia.json`, `optimismsepolia.json`. Sepolia: Diamond, Executor `0x7b01E6A2badAB05e2afaAeFf963f60B5FCF3a533` (code present), ERC20Proxy, Permit2Proxy, **ReceiverAcrossV4**, ReceiverOIF; no Patcher, no ReceiverStargateV2. Base/Arb Sepolia files list identical addresses incl. `AcrossFacetV4` + ReceiverAcrossV4 (only Sepolia + Base Sepolia were code-checked).
- ⇒ The testnet path is "LI.FI's real contracts, our own calldata builder, Across testnet as the rail".

## Across (H unless noted)

- `outputAmount` fixed at deposit (`SpokePool.sol` `depositV3`); destination `fillRelay(RelayData{bytes32…}, repaymentChainId, repaymentAddress)` (selector `0xdeff4b24`) calls `handleV3AcrossMessage(token, amount, relayer, message)` on a contract recipient. Fills are optimistic: only `fillDeadline`, exclusivity and the fill status are checked on the destination.
- `MulticallHandler` (same address on every chain, `0x0F7Ae28dE1C8532170AD4ee566B5801485c13a0E`): `Instructions{Call[]{target,callData,value}; fallbackRecipient}`; no fallback → any failure reverts the fill; with fallback → `CallsFailed`, tokens to fallback; `makeCallWithBalance` patches the live balance into calldata.
- Refunds: expired deposits refund to `refundAddress` (default depositor), origin chain, "several hours".
- Testnet: routes Base/Arb/OP Sepolia → Sepolia for USDC, WETH, ETH (+ a USDC→USDT route); `suggested-fees` simulates messages (an approve-only message quoted: 5 USDC → 4.10 out, gas fee 0.90 USDC). Our `createPortal + approve + depositToAztecPrivate` message → `AMOUNT_TOO_LOW`: testnet liquidity caps (8.0 USDC, 0.00296 WETH) sit below the fee of a ~500k-gas fill. Pre-creating the portal (~190k-gas fill) or self-filling (anyone may fill) unblocks it. Relayer activity thin (1 `FilledRelay` in ~20k Sepolia blocks).
- Mainnet routes into Ethereum (live `available-routes`, 66): USDC, USDT, WETH/ETH, WBTC, WLD (+USDC variants) from ~20 chains. No DAI.
- Addresses: SpokePool mainnet `0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5`, Sepolia `0x5ef6C01E11889d86803e0B23e3cB3F9E9d97B662`, Base Sepolia `0x82B564983aE7274c86695917BBf8C99ECb6F0F8F`, Arb Sepolia `0x7E63A5f1a8F0B4d0934B2f2327DAED3F6bb2ee75`.

## Stargate v2 compose griefing (H)

`ReceiverStargateV2` (lifinance/contracts) states it: LayerZero `lzCompose` is permissionless and must be replayed with the same parameters, so a front-runner can execute it with too little gas and force the "recover only" path (raw tokens to `receiver`). `recoverGas` is reserved (100000 in the deploy config, M). LI.FI's Across receivers reserve no recovery gas (M). Treat "delivered to the user's Ethereum address" as a normal outcome the app must handle.

## Socket / Bungee (H on availability)

`public-backend.bungee.exchange` → 410 "migrate to Socket V3"; V3 (`backend.socket.tech/v3/swap/*`) needs `x-api-key` + `affiliate`; destination payloads via `IBungeeExecutor.executeData(quoteId, amount, token, callData)`; no testnet documented. Dropped.

## NEAR Intents (H unless noted)

1Click `https://1click.chaindefuser.com/v0`: 203 assets / 36 chains; Ethereum assets include USDC, USDT, ETH, WBTC, cbBTC, DAI. `EXACT_OUTPUT` delivers exactly the requested amount. No destination calldata (unknown properties rejected with 400; `customRecipientMsg` is NEAR-only, experimental). No testnet (FAQ: test on mainnet). Unauthenticated quotes +0.25% fee. PoA bridge = federated operators (M). A ~$3.8M exploit in the Omni deposit/withdraw layer was reported by The Block and others ("NEAR Intents halts services after $3.8 million exploit, promises full compensation"); post-mortem pending at research time. Out of scope; see deferred-designs.md.

## Other bridges (M)

CCTP v2 (TokenMessengerV2 `0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA`, MessageTransmitterV2 `0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275` on Sepolia/Base/Arb/OP Sepolia): hooks are integrator-executed. CCIP Sepolia router `0x0BF3dE8c5D3e8A2B34D2BEeB17ABfCeBaf363A59`, CCIP-BnM only. deBridge, Squid: mainnet only. Everclear: Sepolia/Arb/OP Sepolia test tokens only.
