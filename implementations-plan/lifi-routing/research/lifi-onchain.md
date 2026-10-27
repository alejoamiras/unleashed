# Research: LI.FI on-chain mechanics and the two fork proofs

Source: `lifinance/contracts` (`main` at research time; deployed bytecode not diffed against it), plus fork suites run against deployed contracts. Confidence **H** unless marked.

## Destination path

Bridge → per-bridge Receiver → `Executor.swapAndCompleteBridgeTokens(bytes32 txId, LibSwap.SwapData[] swapData, address transferredAssetId, address receiver)` → `LibSwap.swap` per step → `callTo.call(callData)`.

- `LibSwap.SwapData{callTo, approveTo, sendingAssetId, receivingAssetId, fromAmount, callData, requiresDeposit}`.
- `LibSwap.swap` requires only `callTo` has code and `fromAmount != 0`; no allowlist in Executor/LibSwap (`Executor.sol` forbids only `callTo == erc20Proxy`). `msg.sender` at our contract = the Executor (or the Patcher when patched).
- Approval: `LibAsset.maxApproveERC20(token, approveTo, fromAmount)` — **MAX, never reset**. Harmless only if our contract never pulls more than it is asked to deposit and the Executor holds nothing between txs (it sweeps leftovers to `receiver`).
- Amount: the Executor passes `SwapData.fromAmount` as baked; it never rewrites calldata. Delivered < `fromAmount` → our pull fails → Receiver's `catch` sends everything to `receiver`. Delivered > → surplus swept to `receiver`.
- `Patcher` (`src/Periphery/Patcher.sol`): `depositAndExecuteWithDynamicPatches(token, valueSource, valueGetter, finalTarget, value, data, offsets, delegateCall)` staticcalls a value (e.g. `balanceOf`) and writes it into calldata offsets. Its `deposit*` variants pull the caller's ENTIRE balance and never refund excess (documented as front-runnable if funds idle there).
- Failure: `ReceiverAcrossV3/V4`: `try executor.swapAndCompleteBridgeTokens … catch { token.safeTransfer(receiver, amount); emit LiFiTransferRecovered(txId, token, receiver, amount, timestamp) }` — the fill does not revert; no gas reserved for the recovery transfer (M). `ReceiverStargateV2`: reserves `recoverGas`; if `gasleft() < recoverGas` it skips the call and pays `receiver`; compose is permissionless ⇒ griefable (see aggregators.md).
- Source side: the diamond's `swapAndStartBridgeTokensViaStargate(BridgeData, SwapData[], StargateData)` (selector `0xa6010a66` in the live quote); `BridgeData.hasDestinationCall = true`; `StargateData.composeMsg = abi.encode(bytes32 txId, SwapData[] swapData, address receiver, …)`; `extraOptions` set lzCompose gas (600000 seen). A fee-collection SwapData step (FeeCollector `collectTokenFees`) precedes the bridge.

## Addresses (code verified via `cast code`, H)

| Contract | Ethereum (1) | Base (8453) | Arbitrum (42161) | Optimism (10) |
|---|---|---|---|---|
| LiFiDiamond | `0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE` | same | same | same |
| Executor | `0xd9B2Da9C45b118e4e93A004FB1452bCDB6cC0E88` | `0x4DaC9d1769b9b304cb04741DCDEb2FC14aBdF110` | `0x2dfaDAB8266483beD9Fd9A292Ce56596a2D1378D` | `0xC9E66aa9b08EB667e450e072E96F7086AD9f2c91` |
| ERC20Proxy | `0x68E1Acfa805dcA813116Ed6507E01c38D44318f0` | `0x74a55CaDb12501A3707E9F3C5dfd8b563C6A5940` | `0x5741A7FfE7c39Ca175546a54985fA79211290b51` | `0x314bE5fcf0A204837896e6028C47A9e1FC2919c7` |
| ReceiverAcrossV3 | `0x81F35E762B6792Eea8781fC52F72e62235A5C416` | `0xca6e6B692F568055adA0bF72A06D1EBbC938Fb23` | same as Base | `0x28C7ef3789cF91C918cf86e5eF4b40FEBE24dAD3` |
| ReceiverAcrossV4 | `0x07Cc0a0b41641D349240e1988169Fa11b31FC24E` | `0x33b255b5db44A78c34381f89f1a454bc0Ef49871` | same as Base | `0xe417AD5eb9e919567620A48B3757cc182cCdf9e4` |
| ReceiverStargateV2 | `0xB539B40793171211DCA8834da044fC14bCe64BDC` | `0x1493e7B8d4DfADe0a178dAD9335470337A3a219A` | same as Base | `0x556701899905f2f83AcA2977D3202Ee3a80f37b7` |
| Patcher | `0x98dE828723F8aC654B79b8A1BB8E1E5D737F4F42` | same | not listed | not listed |
| Permit2Proxy | `0x89c6340B1a1f4b25D36cd8B063D49045caF3f818` (all four; not code-checked) | | | |

Sepolia: Diamond `0xeCeC3970Ca674278DA8D9B1c484ACaF6B20181F5`, Executor `0x7b01E6A2badAB05e2afaAeFf963f60B5FCF3a533`; ReceiverAcrossV4 listed (address in `deployments/sepolia.json`, not yet code-checked).

## Aztec mainnet facts used by the mainnet fork

Registry `0x35b22e09ee0390539439e24f06da43d83f90e298` (from memory, verified on chain: `getCanonicalRollup()` = `0x91fF8bbD8Ebb07893010D50A48A1609e5EBd8E34` = FeeJuicePortal `ROLLUP()`); Inbox `0x7d4Ef0676c2032bbCC09227501D34d86641ab8cA`, Outbox `0x5B062aB5fD3A66BC7e73b04CeD38587673b6A2D7`, version 4248422647. FeeJuicePortal `0xaf73dd51d1eb8a079bb097f39c832cdd00ac691c`, `UNDERLYING()` = AZTEC `0xa27ec0006e59f245217ff08cd52a7e8b169e62d2` (18 decimals). **Mainnet Inbox emits `MessageSent(uint256 indexed checkpointNumber, uint256 index, bytes32 indexed hash, bytes16 rollingHash)`**, a different topic0 from the repo's pinned `IInbox` (mainnet runs an older Aztec line); `sendL2Message` itself is compatible.

## Fork proof 1 — Across direct → our live testnet generation (`fork-proofs/AcrossFill.t.sol`)

Sepolia fork, block 11842027. Real `SpokePool.fillRelay` → `MulticallHandler` → `[factory.createPortal(T), T.approve(portal, amt), portal.depositToAztecPrivate(amt, secretHash)]`, T ∈ {WETH, Circle USDC}. Result: `6 passed; 0 failed`.
- Success: `DepositToAztecPrivate` with exact amount; Inbox emitted 2 messages (register + deposit); zero residue in handler/relayer/user. Fill gas ≈ 507–510k incl. `createPortal` (~322k) ⇒ ~190k with an existing portal (estimate).
- `fallbackRecipient` set + deposit forced to revert (`depositsPaused` mocked): fill succeeds, user's L1 address receives the full amount.
- `fallbackRecipient = 0`: fill reverts (relayer would not fill → origin refund after deadline).
- The deployed Sepolia SpokePool transfers WETH as WETH to the handler (no unwrap); mainnet behaviour must be re-checked (an unwrap to ETH would strand ETH on the fallback path).
- Run: `forge test --fork-url <sepolia rpc> --fork-block-number 11842027` with forge-std only (interfaces, no repo contracts).

## Fork proof 2 — LI.FI's real destination stack → our contracts on Aztec mainnet (`fork-proofs/LifiDest.t.sol`)

Ethereum mainnet fork, block 26118841; our `PortalFactory`/`TokenPortalImpl` deployed on the fork against the real Aztec registry; real `SpokePool.fillRelay` → `ReceiverAcrossV3|V4` → `Executor` (→ `Patcher`) → `portal.depositToAztecPrivate`. Result: `8 passed; 0 failed`.
- Happy V3/V4: exact deposit, Inbox message, zero residue; whole fill ≈ 326,926 gas (portal pre-created).
- Mismatch, fixed calldata: +1 → deposits F, 1 wei to `receiver`; −1 → pull fails, Receiver recovers all to `receiver`, `LiFiTransferRecovered` emitted, no Inbox message.
- Patcher (`depositAndExecuteWithDynamicPatches`, patch offset 4 = the amount word): deposits exactly what arrived (F, F+1, F−1).
- Guardian pause (real `setPaused`, not a mock): deposit reverts, full amount to `receiver` on Ethereum.
- Finding: a `secretHash` ≥ the BN254 modulus makes the Inbox revert (`Inbox__SecretHashTooLarge`) → recovered to `receiver`. Calldata with a wrong-but-valid secret hash is NOT caught by anything.
- Run: copy `contracts/bridge/evm/{src,script,foundry.toml}`, generate remappings, add the test, `forge test --match-contract LifiDest` (fork URL + block pinned in `setUp`).
