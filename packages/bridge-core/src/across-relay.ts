/** An Across v4 relay's identity: its fields, the hash a SpokePool keys it by, and the event a fill logs. Viem only. */
import { encodeAbiParameters, type Hex, keccak256, parseAbiItem, toEventSelector, zeroHash } from "viem"

/** `V3SpokePoolInterface.V3RelayData`, field for field. */
export interface AcrossRelayData {
	depositor: Hex
	recipient: Hex
	exclusiveRelayer: Hex
	inputToken: Hex
	outputToken: Hex
	inputAmount: bigint
	outputAmount: bigint
	originChainId: bigint
	depositId: bigint
	fillDeadline: number
	exclusivityDeadline: number
	message: Hex
}

/** {@link AcrossRelayData} as the ABI tuple a SpokePool takes. */
export const RELAY_DATA = {
	name: "relayData",
	type: "tuple",
	components: [
		{ name: "depositor", type: "bytes32" },
		{ name: "recipient", type: "bytes32" },
		{ name: "exclusiveRelayer", type: "bytes32" },
		{ name: "inputToken", type: "bytes32" },
		{ name: "outputToken", type: "bytes32" },
		{ name: "inputAmount", type: "uint256" },
		{ name: "outputAmount", type: "uint256" },
		{ name: "originChainId", type: "uint256" },
		{ name: "depositId", type: "uint256" },
		{ name: "fillDeadline", type: "uint32" },
		{ name: "exclusivityDeadline", type: "uint32" },
		{ name: "message", type: "bytes" },
	],
} as const

/** `SpokePool.getV3RelayHash` on the chain `destinationChainId`: every relay field, the full message
 *  included, so a fill that alters any of them is another relay. */
export function acrossRelayHash(relay: AcrossRelayData, destinationChainId: number): Hex {
	return keccak256(encodeAbiParameters([RELAY_DATA, { type: "uint256" }], [relay, BigInt(destinationChainId)]))
}

export const FILLED_RELAY = parseAbiItem(
	"event FilledRelay(bytes32 inputToken, bytes32 outputToken, uint256 inputAmount, uint256 outputAmount, uint256 repaymentChainId, uint256 indexed originChainId, uint256 indexed depositId, uint32 fillDeadline, uint32 exclusivityDeadline, bytes32 exclusiveRelayer, bytes32 indexed relayer, bytes32 depositor, bytes32 recipient, bytes32 messageHash, (bytes32 updatedRecipient, bytes32 updatedMessageHash, uint256 updatedOutputAmount, uint8 fillType) relayExecutionInfo)",
)
/** The selector of the `FilledRelay` a SpokePool logs for every fill it executes. */
export const FILLED_RELAY_TOPIC = toEventSelector(FILLED_RELAY)

/** The relay a `FilledRelay` names: every relay field but the message, which it logs as `messageHash`. */
export type FilledRelayIdentity = Omit<AcrossRelayData, "message"> & { messageHash: Hex }

/** The `messageHash` a `FilledRelay` logs: zero for an empty message. */
const relayMessageHash = (message: Hex): Hex => (message === "0x" ? zeroHash : keccak256(message))

/**
 * Whether `fill` filled the relay carrying `message` whose hash on `destinationChainId` is `relayHash`. Anyone can
 * fill a relay of their own that reuses a deposit's origin and id, so only the message hash and the relay hash rebuilt
 * from every logged field identify the fill.
 */
export function fillsRelay(fill: FilledRelayIdentity, message: Hex, relayHash: Hex, destinationChainId: number): boolean {
	if (fill.messageHash.toLowerCase() !== relayMessageHash(message).toLowerCase()) return false
	const relay: AcrossRelayData = {
		depositor: fill.depositor,
		recipient: fill.recipient,
		exclusiveRelayer: fill.exclusiveRelayer,
		inputToken: fill.inputToken,
		outputToken: fill.outputToken,
		inputAmount: fill.inputAmount,
		outputAmount: fill.outputAmount,
		originChainId: fill.originChainId,
		depositId: fill.depositId,
		fillDeadline: fill.fillDeadline,
		exclusivityDeadline: fill.exclusivityDeadline,
		message,
	}
	return acrossRelayHash(relay, destinationChainId).toLowerCase() === relayHash.toLowerCase()
}
