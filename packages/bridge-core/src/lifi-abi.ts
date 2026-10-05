import type { Address, Hex } from "viem"

/** `LibSwap.SwapData`: one call the LI.FI Executor (or a swap facet) makes, approving `approveTo` for `fromAmount` first. */
export interface LifiSwapData {
	callTo: Address
	approveTo: Address
	sendingAssetId: Address
	receivingAssetId: Address
	fromAmount: bigint
	callData: Hex
	requiresDeposit: boolean
}

export const LIFI_SWAP_DATA_COMPONENTS = [
	{ name: "callTo", type: "address" },
	{ name: "approveTo", type: "address" },
	{ name: "sendingAssetId", type: "address" },
	{ name: "receivingAssetId", type: "address" },
	{ name: "fromAmount", type: "uint256" },
	{ name: "callData", type: "bytes" },
	{ name: "requiresDeposit", type: "bool" },
] as const

/** `ILiFi.BridgeData`, the first argument of every LI.FI bridge entrypoint. */
export interface LifiBridgeData {
	transactionId: Hex
	bridge: string
	integrator: string
	referrer: Address
	sendingAssetId: Address
	receiver: Address
	minAmount: bigint
	destinationChainId: bigint
	hasSourceSwaps: boolean
	hasDestinationCall: boolean
}

export const LIFI_BRIDGE_DATA_COMPONENTS = [
	{ name: "transactionId", type: "bytes32" },
	{ name: "bridge", type: "string" },
	{ name: "integrator", type: "string" },
	{ name: "referrer", type: "address" },
	{ name: "sendingAssetId", type: "address" },
	{ name: "receiver", type: "address" },
	{ name: "minAmount", type: "uint256" },
	{ name: "destinationChainId", type: "uint256" },
	{ name: "hasSourceSwaps", type: "bool" },
	{ name: "hasDestinationCall", type: "bool" },
] as const

/**
 * What LI.FI's destination receivers (ReceiverAcrossV4, ReceiverStargateV2) decode from the bridge message:
 * `abi.encode(bytes32 transactionId, SwapData[] swapData, address receiver)`. `receiver` gets the delivered
 * asset when the Executor's steps revert (`LiFiTransferRecovered`) and any surplus when they succeed.
 */
export const LIFI_RECEIVER_MESSAGE_PARAMS = [
	{ name: "transactionId", type: "bytes32" },
	{ name: "swapData", type: "tuple[]", components: LIFI_SWAP_DATA_COMPONENTS },
	{ name: "receiver", type: "address" },
] as const
