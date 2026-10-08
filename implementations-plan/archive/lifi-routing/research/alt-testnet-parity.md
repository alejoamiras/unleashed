# Testnet parity: Base Sepolia AcrossFacetV4 -> Across -> Sepolia ReceiverAcrossV4 -> Executor -> our router

Tags: [H/M/L] confidence. Sources: `cast` against publicnode RPCs (read-only), lifinance/contracts `main` raw files (`deployments/*.json`, `src/...`), testnet.across.to API (2 requests used), li.quest (0 used).

## Verdict

Feasible today, H. Every LI.FI contract on the path is deployed, has code, is wired, and points at the right SpokePool and Executor on both testnet chains. The only extra work is that OUR code builds the `BridgeData`/`AcrossV4Data` calldata and the `message`. No contract-side check blocks a self-built call. The Across testnet quote for a message-carrying deposit to the Sepolia Receiver returns a normal quote (no error). Residual risks: (a) Across testnet relayer fill reliability and fee swings for tiny amounts, (b) the destination call runs inside the Receiver's try/catch, so a reverting router silently degrades to "USDC sent to `receiver`" (not a failed fill), (c) LGPL if we vendor sources.

## 1. Deployments (`deployments/sepolia.json`, `basesepolia.json`) [H]

Code size = `cast code <addr> --rpc-url <chain> | wc -c` hex chars (>3 means code present); all listed addresses have code.

| Contract | Sepolia (11155111) | Base Sepolia (84532) |
|---|---|---|
| LiFiDiamond | `0xeCeC3970Ca674278DA8D9B1c484ACaF6B20181F5` (proxy, 255 B) | `0x816Fc6EeE47e3157A666827a0C06205294C81770` (255 B) |
| Executor | `0x7b01E6A2badAB05e2afaAeFf963f60B5FCF3a533` (7.7 KB) | `0xa23f49d4eec23D58f5C000f51969AcEDe42a5E54` |
| ERC20Proxy | `0xEd0DB7Be03Fd3de0481f6774d9173787571Bc9Ac` | `0x209eEd931982474CcFAe452730F224aa261263ed` |
| Permit2Proxy | `0xBC2fEd259E6868c85987EDe6bCD2b1C3B9b3C4Bd` | `0xC55CB7741da5519f0AdF5f13E9609311e7097A24` |
| ReceiverAcrossV4 | `0x51Cd54Fab6Bc72c4c313C7d2DD4E0bE1A4390f44` (4.1 KB) | `0x0957F75A2b33f5088FCbE7C6A768fD0a8c2ce1F0` |
| AcrossFacetV4 | `0x50eB18E9fE614654780B8d173bB900D327053Eb9` (8.5 KB) | `0xed86e8F84072BC066A353a2180F38E5268F32B26` |
| FeeCollector | none listed | `0xc199Ac0C619e3333F0b80306Fc0657ed7417730F` |
| Patcher | none in either file | none |

The two diamond addresses you gave for Sepolia match; the Base Sepolia diamond is the one above. Across: Sepolia SpokePool (`0x5ef6...B662`) and Base Sepolia (`0x82B5...0F8F`) have code; MulticallHandler `0x0F7A...3a0E` has code on Sepolia. Executor and the Receiver have the same bytecode size on both testnets and mainnet Receiver (8361 hex chars) so they are the same build.

## 2. Diamond wiring [H]

Selectors (computed with `cast sig` from facet source): `startBridgeTokensViaAcrossV4(BridgeData,AcrossV4Data)` = `0xa1f1ce43`; `swapAndStartBridgeTokensViaAcrossV4(BridgeData,SwapData[],AcrossV4Data)` = `0x1794958f`. Tuple types: BridgeData `(bytes32,string,string,address,address,address,uint256,uint256,bool,bool)`; AcrossV4Data `(bytes32,bytes32,bytes32,bytes32,uint256,uint128,bytes32,uint32,uint32,uint32,bytes)`.

`cast call <diamond> "facetAddress(bytes4)(address)" <sel>`:
- Base Sepolia diamond: both selectors -> `0xed86...2B26` (the AcrossFacetV4 above). It is also in `facetAddresses()`.
- Sepolia diamond: both -> `0x50eB...3Eb9`.
- Mainnet diamond (`0x1231...4EaE`): both -> `0xAd3f1634a917924cBb54A0F76e43ca035D2B6BCd`.
- GenericSwapFacetV3 (`swapTokensSingleV3ERC20ToERC20(bytes32,string,string,address,uint256,(address,address,address,address,uint256,bytes,bool))`, and `...MultipleV3ERC20ToERC20` variant): wired on Sepolia (`0xa612...05F6`), Base Sepolia (`0x710E...6A05`), and mainnet (`0x8C9d...7790`). Not needed for our path, only a destination-side option.

## 3. Immutables [H]

Source `src/Periphery/ReceiverAcrossV4.sol`: `EXECUTOR`, `SPOKEPOOL` immutables, owner via `WithdrawablePeriphery`.
- Sepolia Receiver: `EXECUTOR()` = `0x7b01...3a533` (the Sepolia Executor), `SPOKEPOOL()` = `0x5ef6...B662` (the SpokePool Across testnet's quote returns as `destinationSpokePoolAddress`: confirmed), owner `0x156CeBba59DEB2cB23742F70dCb0a11cC775591F`.
- Base Sepolia Receiver: Executor `0xa23f...5E54`, SpokePool `0x82B5...0F8F`, same owner.
- Mainnet Receiver `0x07Cc...C24E`: Executor `0xd9B2...0E88`, SpokePool `0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5`, same owner. So testnet and mainnet Receiver differ only in the two immutables.
- AcrossFacetV4 (Base Sepolia): `SPOKEPOOL()` = `0x82B5...0F8F` (== quote's `spokePoolAddress`), `WRAPPED_NATIVE()` = `0x4200...0006`. Sepolia facet: spokepool `0x5ef6...`, WETH `0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14`.
- Sepolia Executor `erc20Proxy()` = `0xEd0D...c9Ac`. Mainnet Executor's = `0x68E1...18f0`.

## 4. Structs and validation (`src/Facets/AcrossFacetV4.sol`, `src/Interfaces/ILiFi.sol`, `src/Helpers/Validatable.sol`) [H]

`ILiFi.BridgeData { bytes32 transactionId; string bridge; string integrator; address referrer; address sendingAssetId; address receiver; uint256 minAmount; uint256 destinationChainId; bool hasSourceSwaps; bool hasDestinationCall; }`

`AcrossV4Data { bytes32 receiverAddress (dst recipient = the Receiver contract, left-padded); bytes32 refundAddress (Across depositor, refunds on expiry; must be non-zero); bytes32 sendingAssetId (inputToken; ERC20 path); bytes32 receivingAssetId (outputToken on dst); uint256 outputAmount; uint128 outputAmountMultiplier (1e18-scaled; used ONLY in the swapAnd... variant, which overwrites outputAmount = minAmount*mult/1e18); bytes32 exclusiveRelayer; uint32 quoteTimestamp; uint32 fillDeadline (dst timestamp); uint32 exclusivityParameter (0 = none, < MAX = offset, else absolute); bytes message }`

Checks (all satisfiable by a self-built call):
- `startBridgeTokensViaAcrossV4`: `hasSourceSwaps` must be false; `validateBridgeData`: `receiver != 0`, `minAmount != 0`, `destinationChainId != block.chainid`.
- `(message.length > 0) == hasDestinationCall` else `InformationMismatch`.
- EVM dst: if `hasDestinationCall` the facet does NOT require `bridgeData.receiver == receiverAddress` (`bridgeData.receiver` is just a non-zero label, conventionally the end user); `receiverAddress != 0`; `refundAddress != 0`.
- ERC20: `LibAsset.depositAsset(sendingAssetId, minAmount)` does `transferFrom(msg.sender, diamond)`, so the user approves the DIAMOND. It then calls SpokePool.deposit with `inputAmount = minAmount`. `bridgeData.sendingAssetId` and `acrossData.sendingAssetId` should match (the facet uses the latter as inputToken and the former for the pull; no cross-check exists, so keep them equal).
- Facet source comment: "only use LI.FI backend-generated calldata" for outputAmount; no on-chain check ties outputAmount to a quote. The SpokePool enforces `quoteTimestamp` within its buffer and `fillDeadline` within its max buffer.
- No allowlist, signature, or API-origin check on this path (the whitelist applies to source-swap `callTo`, which `startBridge...` does not use).

Receiver decoding: `abi.decode(message, (bytes32 transactionId, LibSwap.SwapData[] swapData, address receiver))`. `LibSwap.SwapData { address callTo; address approveTo; address sendingAssetId; address receivingAssetId; uint256 fromAmount; bytes callData; bool requiresDeposit; }`.

Executor path (`src/Periphery/Executor.sol`, `LibSwap.sol`): Receiver approves `amount` of `tokenSent` to the Executor, which pulls the full allowance, then for each SwapData: `callTo` must be a contract and != ERC20Proxy, `fromAmount != 0`, max-approves `approveTo` for `fromAmount` (if sendingAssetId is non-native), then `callTo.call(callData)`. NO destination allowlist, so an arbitrary router is callable. Afterwards leftover `tokenSent` and any positive delta of the last `receivingAssetId` are forwarded to `receiver`. Set `fromAmount` = the exact fill amount (= deposit `outputAmount`), `receivingAssetId` = a token the router sends back or the sent token.

## 5. Failure path [H]

- Only `SPOKEPOOL` can call `handleV3AcrossMessage(address tokenSent,uint256 amount,address,bytes message)` (`onlySpokepool`, else `UnAuthorized`).
- No gas reservation / recoverGas in this contract. `try EXECUTOR.swapAndCompleteBridgeTokens(...) {} catch { LibAsset.transferERC20(assetId, receiver, amount); emit LiFiTransferRecovered }`. Because the catch uses all remaining gas semantics of a 63/64 forward, an out-of-gas inner revert leaves only 1/64 for the recovery transfer: a real risk to size gas for (M, general EVM behavior, not verified on-chain).
- If the abi.decode of `message` itself fails (malformed message), `handleV3AcrossMessage` reverts, the fill reverts, and the relayer will not fill (funds refundable to `refundAddress` after expiry). A catch-less revert is also possible if the recovery transfer reverts.
- Native vs WETH: Across always delivers the wrapped token (`WETH 0xfFf9...6B14` on Sepolia); the Receiver has no native handling (comment says so). Approval is reset to 0 after the call.

## 6. License [H]

`LICENSE` = GNU Lesser General Public License v3; every file inspected carries `SPDX-License-Identifier: LGPL-3.0-only`. Vendoring Executor/Receiver/LibSwap/LibAsset into a test harness is allowed (LGPL permits copying and modification). Obligations (not legal advice, M): keep the license/copyright notices, ship the LGPL text with them, license modifications to those files under LGPL-3.0, keep them as separable files so users can replace them. Our own router merely being called by them is not a derivative work. Alternative needing no vendoring: fork-test against the live Sepolia bytecode.

## 7. Across testnet (`https://testnet.across.to/api`) [H]

`/available-routes?originChainId=84532&destinationChainId=11155111` returns four routes: WETH->WETH (`0x4200...0006` -> `0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14`), ETH(native)->ETH, USDC (`0x036CbD53842c5426634e7929541eC2318f3dCF7e`) -> USDC (`0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238`), USDC -> USDT (`0x7169D38820dfd117C3FA1f22a697dBA58d90BA06`).

`/suggested-fees` with Base Sepolia USDC -> Sepolia USDC, amount 5000000 (5 USDC), `recipient` = Sepolia Receiver, `message` = abi.encode(txId, [SwapData(USDC,USDC,USDC,USDC,1,balanceOf(Receiver),false)], owner) (962 hex chars). Result: HTTP 200, no error, `isAmountTooLow:false`; `totalRelayFee` 1,223,582 (24.47%, of which relayerGasFee 1,221,084, capital 500, lp 1,998); `outputAmount` 3,776,418; `limits`: `minDeposit` 4,886,290, `maxDeposit`/`maxDepositInstant` 8,000,264; `spokePoolAddress` = Base Sepolia pool, `destinationSpokePoolAddress` = Sepolia pool (both match the facet/Receiver immutables); `exclusiveRelayer` zero, `exclusivityDeadline` 0; `estimatedFillTimeSec` 10; `fillDeadline` returned. Takeaway: at 5 USDC the gas fee is ~24% and the minDeposit is just under 5 USDC, so test amounts should sit between ~5 and 8 USDC (or use WETH). Not verified: an actual relayer fill of such a deposit (no tx sent).

## 8. Feasibility and blockers

Can our code drive it today? Yes, H for the contract path; M for end-to-end liveness (needs one real send to prove the relayer fills a Receiver message).

Blockers found: none hard. Watch items:
1. LI.FI API will not quote testnet calls: we encode `startBridgeTokensViaAcrossV4` ourselves with `hasDestinationCall=true`, `receiverAddress`=Sepolia Receiver, non-empty `message`, `outputAmount`/`quoteTimestamp`/`fillDeadline` from Across `/suggested-fees` (`outputAmount`, `timestamp`, `fillDeadline`). Required quote `message` must be passed to `/suggested-fees` too, since gas fee depends on it.
2. Input must exceed `minDeposit` (~4.89 USDC at quote time); fees are large at small sizes.
3. Destination router revert is swallowed by the Receiver (funds go to `receiver` as `LiFiTransferRecovered`): tests must assert on the router's own effect, not on fill success.
4. Mainnet and testnet differ in ReceiverAcrossV4 immutables only (`EXECUTOR`, `SPOKEPOOL`); the Executor/Receiver bytecode sizes match, but the Diamond/AcrossFacet addresses differ per chain, so the router must not hardcode them.
5. Relayer testnet reliability is out of our control. Fallbacks: (a) sandbox/anvil harness with vendored (LGPL) Executor + ReceiverAcrossV4 and a mock SpokePool that calls `handleV3AcrossMessage`; (b) Sepolia fork test calling the real Receiver by impersonating the SpokePool (`anvil --fork-url ... ` + `vm.prank(0x5ef6...)`), which exercises LI.FI's real bytecode without a relayer; (c) call `Executor.swapAndCompleteBridgeTokens` directly on Sepolia from a EOA with approved USDC (the Receiver step is skipped).
