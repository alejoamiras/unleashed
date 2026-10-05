import { type Address, encodeAbiParameters, encodeFunctionData, type Hex, pad, size, zeroAddress } from "viem"
import { LIFI_BRIDGE_DATA_COMPONENTS, LIFI_RECEIVER_MESSAGE_PARAMS, type LifiBridgeData, type LifiSwapData } from "./lifi-abi"

/**
 * LI.FI's `AcrossFacetV4.startBridgeTokensViaAcrossV4`. Our own builder, not an API quote: li.quest quotes no
 * testnet, so the testnet rail encodes the Diamond call itself and the client decoder checks it like any quote.
 */
export const ACROSS_V4_FACET_ABI = [
	{
		type: "function",
		name: "startBridgeTokensViaAcrossV4",
		stateMutability: "payable",
		inputs: [
			{ name: "_bridgeData", type: "tuple", components: LIFI_BRIDGE_DATA_COMPONENTS },
			{
				name: "_acrossData",
				type: "tuple",
				components: [
					{ name: "receiverAddress", type: "bytes32" },
					{ name: "refundAddress", type: "bytes32" },
					{ name: "sendingAssetId", type: "bytes32" },
					{ name: "receivingAssetId", type: "bytes32" },
					{ name: "outputAmount", type: "uint256" },
					{ name: "outputAmountMultiplier", type: "uint128" },
					{ name: "exclusiveRelayer", type: "bytes32" },
					{ name: "quoteTimestamp", type: "uint32" },
					{ name: "fillDeadline", type: "uint32" },
					{ name: "exclusivityParameter", type: "uint32" },
					{ name: "message", type: "bytes" },
				],
			},
		],
		outputs: [],
	},
] as const

export const START_BRIDGE_TOKENS_VIA_ACROSS_V4_SELECTOR = "0xa1f1ce43"

export interface AcrossV4DepositParams {
	/** The LI.FI Diamond on the source chain; the user approves it for exactly `inputAmount`. */
	diamond: Address
	transactionId: Hex
	integrator: string
	/** The depositor: Across's refund address and the recovery recipient of the destination message. */
	user: Address
	inputToken: Address
	inputAmount: bigint
	destinationChainId: bigint
	/** LI.FI's ReceiverAcrossV4 on the destination chain, the Across recipient that runs the message. */
	destinationReceiver: Address
	outputToken: Address
	/** What the relayer delivers on the destination: `inputAmount` minus Across's relay fee. */
	outputAmount: bigint
	quoteTimestamp: number
	fillDeadline: number
	/** The Executor's steps on the destination; at least one, since the deposit always carries a call. */
	steps: readonly LifiSwapData[]
}

export function encodeLifiReceiverMessage(transactionId: Hex, steps: readonly LifiSwapData[], receiver: Address): Hex {
	return encodeAbiParameters(LIFI_RECEIVER_MESSAGE_PARAMS, [transactionId, steps, receiver])
}

function word(a: Address): Hex {
	return pad(a, { size: 32 })
}

function assertDepositShape(p: AcrossV4DepositParams): void {
	if (size(p.transactionId) !== 32) throw new Error("across-v4: transactionId must be 32 bytes")
	if (p.user === zeroAddress) throw new Error("across-v4: user is the zero address")
	if (p.inputAmount <= 0n || p.outputAmount <= 0n) throw new Error("across-v4: amounts must be positive")
	// Every rail asset bridges to itself with equal decimals, so an output above the input is a mis-built route.
	if (p.outputAmount > p.inputAmount) throw new Error("across-v4: outputAmount exceeds inputAmount")
	if (p.fillDeadline <= p.quoteTimestamp) throw new Error("across-v4: fillDeadline must follow quoteTimestamp")
	if (p.steps.length === 0) throw new Error("across-v4: a deposit without destination steps is not a route of ours")
}

/**
 * Encodes the Diamond call for an Across V4 deposit that carries a LI.FI destination message.
 *
 * `BridgeData.receiver` is the user: with a message present the facet does not compare it to `receiverAddress`.
 * `outputAmountMultiplier` is 0 because only the swap-and-bridge entrypoint reads it. Throws on a shape no
 * route of ours can have (see {@link assertDepositShape}); it does not check addresses against any book.
 */
export function buildAcrossV4Deposit(p: AcrossV4DepositParams): { to: Address; data: Hex; value: bigint } {
	assertDepositShape(p)
	const bridgeData: LifiBridgeData = {
		transactionId: p.transactionId,
		bridge: "acrossV4",
		integrator: p.integrator,
		referrer: zeroAddress,
		sendingAssetId: p.inputToken,
		receiver: p.user,
		minAmount: p.inputAmount,
		destinationChainId: p.destinationChainId,
		hasSourceSwaps: false,
		hasDestinationCall: true,
	}
	const data = encodeFunctionData({
		abi: ACROSS_V4_FACET_ABI,
		functionName: "startBridgeTokensViaAcrossV4",
		args: [
			bridgeData,
			{
				receiverAddress: word(p.destinationReceiver),
				refundAddress: word(p.user),
				sendingAssetId: word(p.inputToken),
				receivingAssetId: word(p.outputToken),
				outputAmount: p.outputAmount,
				outputAmountMultiplier: 0n,
				exclusiveRelayer: pad("0x", { size: 32 }),
				quoteTimestamp: p.quoteTimestamp,
				fillDeadline: p.fillDeadline,
				exclusivityParameter: 0,
				message: encodeLifiReceiverMessage(p.transactionId, p.steps, p.user),
			},
		],
	})
	return { to: p.diamond, data, value: 0n }
}
