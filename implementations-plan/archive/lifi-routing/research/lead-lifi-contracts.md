# Research (lead): LI.FI on-chain pieces the plan leans on

Lead-planner round. Source: `lifinance/contracts` on `main` read as raw files (paths below are repo-relative to that repository), plus read-only `cast` probes. Confidence **H** unless marked.

## GenericSwapFacetV3 (`src/Facets/GenericSwapFacetV3.sol`, `@custom:version` 2.0.0)

- Six entrypoints, all `(bytes32 _transactionId, string _integrator, string _referrer, address payable _receiver, uint256 _minAmountOut, X _swapData)`: `swapTokensSingleV3ERC20ToERC20` (`0x4666fc80`), `…SingleV3ERC20ToNative`, `…SingleV3NativeToERC20` (payable), `swapTokensMultipleV3ERC20ToERC20` (`0x5fd9ae2e`), `…MultipleV3ERC20ToNative`, `…MultipleV3NativeToERC20` (`0x736eac0b`, payable). X = `LibSwap.SwapData` or `LibSwap.SwapData[]`.
- Live mainnet quotes use the **Multiple** variant (see `lead-lifi-api-shapes.md`): SwapData[0] = LI.FI fee collection (pulls the full input from `msg.sender`), SwapData[1] = the DEX call.
- Input is pulled with `transferFrom(msg.sender, diamond, fromAmount)`; any contract may call; **no reentrancy guard, no deadline**.
- Allowlist: `LibAllowList.contractSelectorIsAllowed(callTo, selector)` per SwapData (and `approveTo` must be allowed as `0xffffffff` when it differs from `callTo`). Managed by the diamond owner through `WhitelistManagerFacet` (`DexManagerFacet` no longer exists).
- `_minAmountOut` is checked against the **diamond's whole balance** of the receiving token (not a delta); the whole balance is then sent to `_receiver`. Leftover sending asset (> 1 wei) is returned to `_receiver` ("positive slippage").
- Facet address for `0x4666fc80` and `0x5fd9ae2e` on the mainnet diamond `0x1231DEB6…4EaE`: `0x8C9dBA771220Ed09580b77F0765e7153fbDE7790` (probe). Sepolia diamond `0xeCeC…81F5` routes `0x4666fc80` to `0xa612a6d05A4F028157050cd2745853a3401305F6` (probe).
- ⇒ A contract that executes LI.FI same-chain calldata must (1) approve the diamond exactly the input, (2) measure output by its own balance delta, (3) expect possible returned input dust, (4) never rely on LI.FI's `_minAmountOut` as its own floor.

## Executor (`src/Periphery/Executor.sol`, 2.1.0)

- `swapAndCompleteBridgeTokens(bytes32, SwapData[], address transferredAssetId, address payable receiver)` is `nonReentrant`, **no allowlist** (only `callTo == erc20Proxy` is refused).
- ERC-20: reads `allowance(msg.sender, Executor)` and pulls exactly that (the Receiver approved exactly the delivered amount), then runs each step through `LibSwap.swap`; afterwards any surplus of the transferred asset and of the final asset is sent to `receiver`; emits `LiFiTransferCompleted(txId, asset, receiver, amount, ts)`.
- `LibSwap.swap` (1.1.0): requires `callTo` to have code (> 23 bytes) and `fromAmount != 0`; **no balance check**; `maxApproveERC20(asset, approveTo, fromAmount)` sets `type(uint256).max` when the allowance is below `fromAmount` and **never resets it**; `requiresDeposit` is ignored here.
- The called contract sees `msg.sender == Executor`. ⇒ Our contract must pull only from `msg.sender`, and may pull the Executor's whole balance (the Patcher already does exactly this against the same Executor, fork proof 2).

## ReceiverAcrossV4 (`src/Periphery/ReceiverAcrossV4.sol`, 1.0.0)

- `constructor(owner, executor, spokepool)`; public immutables `EXECUTOR`, `SPOKEPOOL`.
- `handleV3AcrossMessage(address tokenSent, uint256 amount, address, bytes message)` is `onlySpokepool`; message = `abi.encode(bytes32 txId, SwapData[] swapData, address receiver)`.
- Approves the Executor **exactly** `amount`, `try executor.swapAndCompleteBridgeTokens(...)`, resets to 0; `catch` transfers `amount` to `receiver` and emits `LiFiTransferRecovered(txId, asset, receiver, amount, ts)`. **No gas reserved** for the catch (M: a near-out-of-gas inner call can make recovery itself fail, which reverts the fill → origin refund after `fillDeadline`).
- Owner function `withdrawToken(asset, receiver, amount)` (no `pullToken`).

## ReceiverStargateV2 (mainnet `0xB539B40793171211DCA8834da044fC14bCe64BDC`)

- Probe: `recoverGas() = 100000`, `executor() = 0xd9B2Da9C…0E88` (the mainnet Executor). `lzCompose` is permissionless at the LayerZero endpoint; below `recoverGas` it pays `receiver` without calling (see `aggregators.md`, griefing).

## AcrossFacetV4 (`src/Facets/AcrossFacetV4.sol`, 1.0.0)

- `startBridgeTokensViaAcrossV4(ILiFi.BridgeData, AcrossV4Data)` = `0xa1f1ce43`; `swapAndStartBridgeTokensViaAcrossV4(BridgeData, SwapData[], AcrossV4Data)` = `0x1794958f`; both `payable nonReentrant`.
- `ILiFi.BridgeData{bytes32 transactionId; string bridge; string integrator; address referrer; address sendingAssetId; address receiver; uint256 minAmount; uint256 destinationChainId; bool hasSourceSwaps; bool hasDestinationCall}`.
- `AcrossV4Data{bytes32 receiverAddress; bytes32 refundAddress; bytes32 sendingAssetId; bytes32 receivingAssetId; uint256 outputAmount; uint128 outputAmountMultiplier; bytes32 exclusiveRelayer; uint32 quoteTimestamp; uint32 fillDeadline; uint32 exclusivityParameter; bytes message}`.
- Checks: `(message.length > 0) != hasDestinationCall` → `InformationMismatch`; without a destination call `receiverAddress` must equal `bytes32(bridgeData.receiver)`; with one the check is skipped (the comment says `receiverAddress` is then LI.FI's receiver contract, M); `receiverAddress`/`refundAddress` non-zero. Calls the V4 bytes32 `SpokePool.deposit(depositor, recipient, inputToken, outputToken, inputAmount, outputAmount, destinationChainId, exclusiveRelayer, quoteTimestamp, fillDeadline, exclusivityParameter, message)`.
- `outputAmountMultiplier` applies only on the swap-and-bridge path.

## Permit2Proxy (`src/Periphery/Permit2Proxy.sol`, 1.0.4)

- `constructor(lifiDiamond, permit2, owner)`; immutables `LIFI_DIAMOND`, `PERMIT2`.
- `callDiamondWithPermit2Witness(bytes diamondCalldata, address signer, PermitTransferFrom permit, bytes signature)`: Permit2 owner is `signer` (relayable); witness type string `"LiFiCall witness)LiFiCall(address diamondAddress,bytes32 diamondCalldataHash)TokenPermissions(address token,uint256 amount)"` binds the diamond and `keccak256(diamondCalldata)`. Also `callDiamondWithPermit2` (owner = `msg.sender`), `callDiamondWithEIP2612Signature`, `getPermit2MsgHash`, `nextNonce`.
- Flow: Permit2 pull to the proxy → `maxApproveERC20(token, LIFI_DIAMOND, amount)` (standing max from the proxy to the diamond; the proxy holds nothing between calls) → `LIFI_DIAMOND.call{value}(calldata)`. No selector restriction. It can only call the diamond: it is a **source-chain** authorization primitive, not something our Ethereum contract can use.

## Patcher (`src/Periphery/Patcher.sol`, 1.0.1)

Patches staticcall results into calldata; `deposit*` variants pull the caller's entire balance, refund nothing, front-runnable, no target allowlist. **Not deployed on Sepolia or Base Sepolia.** Not needed by this plan.

## Deployments (from `deployments/*.json`; probes confirm wiring)

| | Ethereum (1) | Sepolia (11155111) | Base Sepolia (84532) |
|---|---|---|---|
| LiFiDiamond | `0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE` | `0xeCeC3970Ca674278DA8D9B1c484ACaF6B20181F5` | `0x816Fc6EeE47e3157A666827a0C06205294C81770` |
| Executor | `0xd9B2Da9C45b118e4e93A004FB1452bCDB6cC0E88` | `0x7b01E6A2badAB05e2afaAeFf963f60B5FCF3a533` | `0xa23f49d4eec23D58f5C000f51969AcEDe42a5E54` |
| ERC20Proxy | `0x68E1Acfa805dcA813116Ed6507E01c38D44318f0` | `0xEd0DB7Be03Fd3de0481f6774d9173787571Bc9Ac` | `0x209eEd931982474CcFAe452730F224aa261263ed` |
| Permit2Proxy | `0x89c6340B1a1f4b25D36cd8B063D49045caF3f818` | `0xBC2fEd259E6868c85987EDe6bCD2b1C3B9b3C4Bd` | `0xC55CB7741da5519f0AdF5f13E9609311e7097A24` |
| ReceiverAcrossV4 | `0x07Cc0a0b41641D349240e1988169Fa11b31FC24E` | `0x51Cd54Fab6Bc72c4c313C7d2DD4E0bE1A4390f44` | `0x0957F75A2b33f5088FCbE7C6A768fD0a8c2ce1F0` |
| AcrossFacetV4 | `0xAd3f1634a917924cBb54A0F76e43ca035D2B6BCd` | `0x50eB18E9fE614654780B8d173bB900D327053Eb9` | `0xed86e8F84072BC066A353a2180F38E5268F32B26` |
| GenericSwapFacetV3 | `0x8C9dBA771220Ed09580b77F0765e7153fbDE7790` | `0xa612a6d05A4F028157050cd2745853a3401305F6` | `0x710Efd35F4a958eA028536c230f3e280B97D6A05` |
| Patcher | `0x98dE828723F8aC654B79b8A1BB8E1E5D737F4F42` | — | — |

`config/across.json` SpokePools: mainnet `0x5c7BCd6E…C35C5`, Sepolia `0x5ef6C01E…B662`, Base Sepolia `0x82B56498…0F8F`. `config/permit2Proxy.json` names canonical Permit2 `0x000000000022D473030F116dDEE9F6B43aC78BA3` on all three.

Runtime code size of the Sepolia Executor and ReceiverAcrossV4 equals mainnet's (15,467 and 8,361 hex chars incl. `0x`), consistent with the same versions (M: immutables differ, so sizes match but hashes were not compared).

## License

Root `LICENSE` is LGPL-3.0; every file checked carries `SPDX-License-Identifier: LGPL-3.0-only` (Executor, ReceiverAcrossV3/V4, LibSwap, LibAsset, Permit2Proxy, GenericSwapFacetV3, AcrossFacetV4, Patcher, ERC20Proxy, LibAllowList, ILiFi). Factual terms: copying/modification allowed; conveyed copies keep notices and the license text; modified covered files stay LGPL. Whether compiling them into one artifact with our `UNLICENSED` contracts forms a "Combined Work" is a legal question this research does not answer. ⇒ Prefer keeping LI.FI code **out of our compilation units**: vendored, unmodified creation bytecode built at a pinned commit, kept under its own directory with the LGPL text and a provenance file, used only by the test sandbox (owner Ask).

## Docs

`/v1/quote/contractCalls` is BETA; `toFallbackAddress` = where bridged tokens go if the call fails (defaults to the sender). Permit flows go through Permit2Proxy; `/v1/chains` publishes `permit2` and `permit2Proxy`. `llms.txt` lists Sepolia, Base Sepolia and Arbitrum Sepolia as available; nothing about contract calls on testnets.
