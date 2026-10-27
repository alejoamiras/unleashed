import { bytesToBigInt, bytesToHex, type Hex, hexToBytes, isHex } from "viem"
import { LIFI_BRIDGE_DATA_COMPONENTS, LIFI_SWAP_DATA_COMPONENTS } from "./lifi-abi"

/** `IStargate.SendParam`, field for field. */
export const STARGATE_SEND_PARAM_COMPONENTS = [
	{ name: "dstEid", type: "uint32" },
	{ name: "to", type: "bytes32" },
	{ name: "amountLD", type: "uint256" },
	{ name: "minAmountLD", type: "uint256" },
	{ name: "extraOptions", type: "bytes" },
	{ name: "composeMsg", type: "bytes" },
	{ name: "oftCmd", type: "bytes" },
] as const

/** `IStargate.MessagingFee`. */
export const STARGATE_MESSAGING_FEE_COMPONENTS = [
	{ name: "nativeFee", type: "uint256" },
	{ name: "lzTokenFee", type: "uint256" },
] as const

/** `StargateFacetV2.StargateData`. */
export const STARGATE_DATA_COMPONENTS = [
	{ name: "assetId", type: "uint16" },
	{ name: "sendParams", type: "tuple", components: STARGATE_SEND_PARAM_COMPONENTS },
	{ name: "fee", type: "tuple", components: STARGATE_MESSAGING_FEE_COMPONENTS },
	{ name: "refundAddress", type: "address" },
] as const

/**
 * LI.FI's `StargateFacetV2` entrypoints. The facet overwrites `sendParams.amountLD` with the post-swap
 * `BridgeData.minAmount`, resolves the pool from `assetId` through Stargate's TokenMessaging, and pays
 * `fee.nativeFee` out of `msg.value`.
 */
export const STARGATE_FACET_V2_ABI = [
	{
		type: "function",
		name: "swapAndStartBridgeTokensViaStargate",
		stateMutability: "payable",
		inputs: [
			{ name: "_bridgeData", type: "tuple", components: LIFI_BRIDGE_DATA_COMPONENTS },
			{ name: "_swapData", type: "tuple[]", components: LIFI_SWAP_DATA_COMPONENTS },
			{ name: "_stargateData", type: "tuple", components: STARGATE_DATA_COMPONENTS },
		],
		outputs: [],
	},
	{
		type: "function",
		name: "startBridgeTokensViaStargate",
		stateMutability: "payable",
		inputs: [
			{ name: "_bridgeData", type: "tuple", components: LIFI_BRIDGE_DATA_COMPONENTS },
			{ name: "_stargateData", type: "tuple", components: STARGATE_DATA_COMPONENTS },
		],
		outputs: [],
	},
] as const

export const SWAP_AND_START_BRIDGE_TOKENS_VIA_STARGATE_SELECTOR = "0xa6010a66"
export const START_BRIDGE_TOKENS_VIA_STARGATE_SELECTOR = "0x14d53077"

/** The pool and TokenMessaging reads a caller needs: the messaging fee to cap, and the pool behind an asset id. */
export const STARGATE_POOL_ABI = [
	{
		type: "function",
		name: "quoteSend",
		stateMutability: "view",
		inputs: [
			{ name: "_sendParam", type: "tuple", components: STARGATE_SEND_PARAM_COMPONENTS },
			{ name: "_payInLzToken", type: "bool" },
		],
		outputs: [{ name: "fee", type: "tuple", components: STARGATE_MESSAGING_FEE_COMPONENTS }],
	},
	{ type: "function", name: "token", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
] as const

export const STARGATE_TOKEN_MESSAGING_ABI = [
	{
		type: "function",
		name: "stargateImpls",
		stateMutability: "view",
		inputs: [{ name: "assetId", type: "uint16" }],
		outputs: [{ name: "", type: "address" }],
	},
] as const

/** Slack over the pool's own `quoteSend` that a route's `fee.nativeFee` may carry: 10 %. */
export const STARGATE_FEE_SLACK_BPS = 1_000n

/** The highest LayerZero native fee a route may charge, given what the source pool's `quoteSend` returned. */
export function stargateFeeCeiling(quotedNativeFee: bigint): bigint {
	return quotedNativeFee + (quotedNativeFee * STARGATE_FEE_SLACK_BPS) / 10_000n
}

/** One LayerZero executor option (worker id 1). An option without `value` decodes with `value` 0. */
export type LzExecutorOption =
	| { kind: "lzReceive"; gas: bigint; value: bigint }
	| { kind: "nativeDrop"; amount: bigint; receiver: Hex }
	| { kind: "lzCompose"; index: number; gas: bigint; value: bigint }
	| { kind: "orderedExecution" }

export class LzOptionsError extends Error {
	constructor(reason: string) {
		super(`LayerZero options: ${reason}`)
		this.name = "LzOptionsError"
	}
}

const OPTIONS_TYPE_3 = 3
const EXECUTOR_WORKER_ID = 1

function uint(bytes: Uint8Array, at: number, size: number): bigint {
	return bytesToBigInt(bytes.subarray(at, at + size))
}

/** Each executor option type at its two legal payload sizes: without and with the trailing `uint128` value. */
function executorOption(optionType: number, p: Uint8Array): LzExecutorOption {
	if (optionType === 1 && (p.length === 16 || p.length === 32)) {
		return { kind: "lzReceive", gas: uint(p, 0, 16), value: p.length === 32 ? uint(p, 16, 16) : 0n }
	}
	if (optionType === 2 && p.length === 48) {
		return { kind: "nativeDrop", amount: uint(p, 0, 16), receiver: bytesToHex(p.subarray(16)) }
	}
	if (optionType === 3 && (p.length === 18 || p.length === 34)) {
		return { kind: "lzCompose", index: Number(uint(p, 0, 2)), gas: uint(p, 2, 16), value: p.length === 34 ? uint(p, 18, 16) : 0n }
	}
	if (optionType === 4 && p.length === 0) return { kind: "orderedExecution" }
	throw new LzOptionsError(`executor option type ${optionType} with a ${p.length}-byte payload`)
}

/**
 * Decodes LayerZero type-3 options (`OptionsBuilder`): a `uint16` 3, then `workerId (1) ‖ size (2) ‖ optionType (1) ‖
 * payload (size − 1)` per option, in order. Throws {@link LzOptionsError} on any other options type, any worker
 * but the executor (DVN options included), an option type or payload length it does not know, or a truncated or
 * trailing byte: an option it cannot read is never assumed harmless.
 */
export function decodeLzOptions(options: Hex): LzExecutorOption[] {
	if (!isHex(options, { strict: true })) throw new LzOptionsError("not hex")
	const bytes = hexToBytes(options)
	if (bytes.length < 2) throw new LzOptionsError("shorter than its type")
	const type = Number(uint(bytes, 0, 2))
	if (type !== OPTIONS_TYPE_3) throw new LzOptionsError(`options type ${type}`)
	const out: LzExecutorOption[] = []
	let at = 2
	while (at < bytes.length) {
		if (at + 4 > bytes.length) throw new LzOptionsError(`truncated option header at byte ${at}`)
		const worker = bytes[at]
		const size = Number(uint(bytes, at + 1, 2))
		if (worker !== EXECUTOR_WORKER_ID) throw new LzOptionsError(`worker ${worker} at byte ${at}`)
		if (size < 1 || at + 3 + size > bytes.length) throw new LzOptionsError(`option at byte ${at} overruns the options`)
		out.push(executorOption(bytes[at + 3], bytes.subarray(at + 4, at + 3 + size)))
		at += 3 + size
	}
	return out
}

/** What EndpointV2 hands `lzCompose` for a Stargate send (`OFTComposeMsgCodec`). */
export interface OftComposeMessage {
	nonce: bigint
	srcEid: number
	/** What the pool credited the compose receiver, in local decimals. */
	amountLD: bigint
	/** The source-chain caller of `sendToken`, left-padded: LI.FI's Diamond for a LI.FI route. */
	composeFrom: Hex
	/** The sender's own message: LI.FI's `abi.encode(transactionId, swapData, receiver)`. */
	composeMsg: Hex
}

/** Decodes `nonce (8) ‖ srcEid (4) ‖ amountLD (32) ‖ composeFrom (32) ‖ composeMsg`; throws when shorter than its head. */
export function decodeOftComposeMessage(message: Hex): OftComposeMessage {
	const bytes = hexToBytes(message)
	if (bytes.length < 76) throw new Error(`OFT compose message: ${bytes.length} bytes, shorter than its 76-byte head`)
	return {
		nonce: uint(bytes, 0, 8),
		srcEid: Number(uint(bytes, 8, 4)),
		amountLD: uint(bytes, 12, 32),
		composeFrom: bytesToHex(bytes.subarray(44, 76)),
		composeMsg: bytesToHex(bytes.subarray(76)),
	}
}
