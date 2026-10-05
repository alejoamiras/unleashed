/**
 * `verifyRoute`: the client's only guard against a redirected cross-chain intent. It decodes the exact transaction
 * the user is about to sign (an li.quest quote, or our own Across builder's bytes on testnet) and compares every
 * field with a stated policy; on-chain checks only bound value loss. It fails closed: an unknown selector, an
 * undecodable or non-canonical encoding, an option it cannot read, or any field outside its policy is a refusal
 * naming that field. It never re-encodes provider bytes for signing; each decoded layer must equal the canonical
 * encoding of its own decoded values, so no byte escapes the comparison.
 *
 * Every decoded leaf is either policed ({@link ROUTE_FIELD_POLICY}) or listed with its reason
 * ({@link ROUTE_UNPOLICED}); `lifi-decode.test.ts` mutates each leaf of the recorded routes to prove it. Checks run
 * in dependency order: each reads only the expectation, the address book, or fields already checked, so a mutated
 * field is refused under its own name.
 */
import {
	type AbiParameterToPrimitiveType,
	type Address,
	decodeAbiParameters,
	decodeFunctionData,
	encodeAbiParameters,
	encodeFunctionData,
	getAbiItem,
	type Hex,
	isHex,
	pad,
	toFunctionSelector,
} from "viem"
import {
	ACROSS_V4_DATA_COMPONENTS,
	ACROSS_V4_FACET_ABI,
	type AcrossV4Data,
	type AcrossV4DepositParams,
	acrossV4Call,
	START_BRIDGE_TOKENS_VIA_ACROSS_V4_SELECTOR,
} from "./across-v4"
import { DEPOSIT_INTENT_COMPONENTS, DEPOSIT_ROUTER_ABI } from "./deposit-router-abi"
import {
	FUEL_SWAP_SELECTORS,
	LIFI_RECEIVER_MESSAGE_PARAMS,
	type LifiBridgeData,
	type LifiSwapData,
	SWAP_TOKENS_MULTIPLE_V3_ABI,
	SWAP_TOKENS_SINGLE_V3_ABI,
} from "./lifi-abi"
import { type LifiChainBook, lifiBook, stargatePoolFor } from "./lifi-addresses"
import { LIFI_ALLOW_EXCHANGES, LIFI_INTEGRATOR, LIFI_MIN_COMPOSE_GAS } from "./lifi-gas"
import {
	decodeLzOptions,
	decodeOftComposeMessage,
	type LzExecutorOption,
	type OftComposeMessage,
	START_BRIDGE_TOKENS_VIA_STARGATE_SELECTOR,
	STARGATE_FACET_V2_ABI,
	SWAP_AND_START_BRIDGE_TOKENS_VIA_STARGATE_SELECTOR,
} from "./stargate"

/** LI.FI's own fee on the fee tier: at most 0.25 % of the input. Our integrator fee is 0, so no second share exists. */
export const LIFI_FEE_CAP_BPS = 25n

const FUEL_SWAP_ABI = [...SWAP_TOKENS_SINGLE_V3_ABI, ...SWAP_TOKENS_MULTIPLE_V3_ABI] as const

/** LI.FI's `FeeForwarder.forwardERC20Fees`, the fee step li.quest prepends to a route. */
export const FEE_FORWARDER_ABI = [
	{
		type: "function",
		name: "forwardERC20Fees",
		stateMutability: "nonpayable",
		inputs: [
			{ name: "_token", type: "address" },
			{
				name: "_distributions",
				type: "tuple[]",
				components: [
					{ name: "recipient", type: "address" },
					{ name: "amount", type: "uint256" },
				],
			},
		],
		outputs: [],
	},
] as const

const FORWARD_ERC20_FEES_SELECTOR: Hex = toFunctionSelector(FEE_FORWARDER_ABI[0])
const BRIDGE_FROM_CALLER_SELECTOR: Hex = toFunctionSelector(getAbiItem({ abi: DEPOSIT_ROUTER_ABI, name: "bridgeFromCaller" }))
const RAIL_SELECTORS: Readonly<Record<RailExpectation["kind"], readonly Hex[]>> = {
	acrossV4: [START_BRIDGE_TOKENS_VIA_ACROSS_V4_SELECTOR],
	stargateV2: [SWAP_AND_START_BRIDGE_TOKENS_VIA_STARGATE_SELECTOR, START_BRIDGE_TOKENS_VIA_STARGATE_SELECTOR],
}

export type RouterIntent = AbiParameterToPrimitiveType<{ type: "tuple"; components: typeof DEPOSIT_INTENT_COMPONENTS }>

/** The source-chain transaction to sign, and the ERC-20 approval sent before it or batched with it. */
export interface RouteTx {
	chainId: number
	from: Address
	to: Address
	value: bigint
	data: Hex
	approval: { token: Address; spender: Address; amount: bigint }
}

export type RailExpectation =
	/** Our own builder's Across inputs: the relay quote's output and its timing. */
	| { kind: "acrossV4"; outputAmount: bigint; quoteTimestamp: number; fillDeadline: number }
	/** `maxNativeFee`: `stargateFeeCeiling` of the source pool's own `quoteSend`, read by the caller. */
	| { kind: "stargateV2"; maxNativeFee: bigint }

/** Structurally `FuelQuote`'s provider fields. */
export type FuelProvider = { provider: "lifi"; tool: string } | { provider: "testnetSwapper" }

/** What the route must do, from the manifest, the user's choice and our own builders; never from the provider. */
export interface RouteExpectation {
	srcChainId: number
	/** The connected account: sender, Stargate refund address, Across depositor, and the destination fallback. */
	user: Address
	srcToken: Address
	/** The input the user approves and the Diamond pulls, LI.FI's fee included. */
	srcAmount: bigint
	/** `BridgeData.transactionId`, the id the journal record keys discovery on. */
	lifiTxId: Hex
	/** Ethereum: the manifest's `l1ChainId`. */
	l1ChainId: number
	/** The manifest's `l1.depositRouter`. */
	router: Address
	/** The routing source's `destToken`: the rail asset on Ethereum. */
	destToken: Address
	/** The manifest's fee asset, which the fuel swap must end in. */
	feeAsset: Address
	/** Our `bridgeFromCaller` calldata exactly as our builder encoded it, fuel quote embedded. */
	routerCall: Hex
	/** The provider of the fuel quote `routerCall` embeds; required whenever its intent carries a slice. */
	fuel?: FuelProvider
	rail: RailExpectation
}

export interface DecodedRouterCall {
	intent: RouterIntent
	swapData: Hex
	minReceived: bigint
	maxPull: bigint
}

export interface DecodedMessage {
	transactionId: Hex
	step: LifiSwapData
	receiver: Address
}

export interface DecodedRoute {
	rail: RailExpectation["kind"]
	bridgeData: LifiBridgeData
	/** LI.FI's source fee step, 0 when the route has none. */
	lifiFee: bigint
	across?: AcrossV4Data
	stargate?: { assetId: number; minAmountLD: bigint; nativeFee: bigint; options: LzExecutorOption[] }
	message: DecodedMessage
	router: DecodedRouterCall
}

export type RouteRefusal = { ok: false; field: string; reason: string }
export type RouteVerdict = { ok: true; decoded: DecodedRoute } | RouteRefusal
export type ComposeVerdict = { ok: true; decoded: { compose: OftComposeMessage; message: DecodedMessage } } | RouteRefusal

export type FieldPolicyKind = "equal" | "atMost" | "atLeast" | "within" | "oneOf"

/**
 * Every policed leaf and the shape of its rule; `[]` matches any index. The rules themselves are the checks below,
 * each naming exactly these fields.
 */
export const ROUTE_FIELD_POLICY: readonly (readonly [field: string, kind: FieldPolicyKind])[] = [
	["tx.chainId", "equal"],
	["tx.from", "equal"],
	["tx.to", "equal"],
	["tx.value", "equal"],
	["approval.token", "equal"],
	["approval.spender", "equal"],
	["approval.amount", "equal"],
	["call.selector", "oneOf"],
	["call._bridgeData.transactionId", "equal"],
	["call._bridgeData.integrator", "equal"],
	["call._bridgeData.sendingAssetId", "equal"],
	["call._bridgeData.receiver", "equal"],
	["call._bridgeData.minAmount", "equal"],
	["call._bridgeData.destinationChainId", "equal"],
	["call._bridgeData.hasSourceSwaps", "equal"],
	["call._bridgeData.hasDestinationCall", "equal"],
	["call._swapData.length", "equal"],
	["call._swapData[0].callTo", "equal"],
	["call._swapData[0].approveTo", "equal"],
	["call._swapData[0].sendingAssetId", "equal"],
	["call._swapData[0].receivingAssetId", "equal"],
	["call._swapData[0].fromAmount", "equal"],
	["call._swapData[0].requiresDeposit", "equal"],
	["fee.selector", "oneOf"],
	["fee._token", "equal"],
	["fee._distributions.length", "equal"],
	["fee._distributions[0].amount", "atMost"],
	...ACROSS_V4_DATA_COMPONENTS.filter((c) => c.name !== "message").map((c) => [`call._acrossData.${c.name}`, "equal"] as const),
	["call._stargateData.assetId", "equal"],
	["call._stargateData.sendParams.dstEid", "equal"],
	["call._stargateData.sendParams.to", "equal"],
	["call._stargateData.sendParams.amountLD", "equal"],
	["call._stargateData.sendParams.minAmountLD", "atLeast"],
	["call._stargateData.sendParams.oftCmd", "equal"],
	["call._stargateData.fee.nativeFee", "atMost"],
	["call._stargateData.fee.lzTokenFee", "equal"],
	["call._stargateData.refundAddress", "equal"],
	["options.lzCompose.length", "equal"],
	["options.lzCompose[0].index", "equal"],
	["options.lzCompose[0].gas", "atLeast"],
	["options.lzCompose[0].value", "equal"],
	["options.lzReceive[].value", "equal"],
	["options.nativeDrop.length", "equal"],
	["options.orderedExecution.length", "equal"],
	["message.transactionId", "equal"],
	["message.swapData.length", "equal"],
	["message.swapData[0].callTo", "equal"],
	["message.swapData[0].approveTo", "equal"],
	["message.swapData[0].sendingAssetId", "equal"],
	["message.swapData[0].receivingAssetId", "equal"],
	["message.swapData[0].fromAmount", "within"],
	["message.receiver", "equal"],
	["router.selector", "oneOf"],
	...DEPOSIT_INTENT_COMPONENTS.map((c) => [`router.intent.${c.name}`, "equal"] as const),
	["router.swapData", "equal"],
	["router.minReceived", "equal"],
	["router.maxPull", "equal"],
	["fuelSwap.selector", "oneOf"],
	["fuelSwap._receiver", "equal"],
	["fuelSwap._minAmountOut", "equal"],
	["fuelSwap._swapData.length", "atMost"],
	["fuelSwap._swapData.sendingAssetId", "equal"],
	["fuelSwap._swapData.receivingAssetId", "equal"],
	["fuelSwap._swapData.fromAmount", "equal"],
	["fuelSwap._swapData[0].sendingAssetId", "equal"],
	["fuelSwap._swapData[0].receivingAssetId", "equal"],
	["fuelSwap._swapData[0].fromAmount", "equal"],
	["fuelSwap._swapData[1].sendingAssetId", "equal"],
	["fuelSwap._swapData[1].receivingAssetId", "equal"],
]

const LABEL = "an event label the facet emits and never acts on"
const INNER_SWAP =
	"the facet's on-chain LibAllowList gates inner targets and calls, and the router's fee-asset floor bounds any loss to the slice"

/** Decoded leaves no policy constrains, each with the reason that is safe. */
export const ROUTE_UNPOLICED: readonly (readonly [field: string, reason: string])[] = [
	["call._bridgeData.bridge", LABEL],
	["call._bridgeData.referrer", LABEL],
	["fee._distributions[0].recipient", "LI.FI's fee wallet; the fee cap bounds what it receives"],
	["options.lzReceive.length", "lzReceive gas options add up; more gas only raises the messaging fee, which its cap bounds"],
	["options.lzReceive[].gas", "more lzReceive gas only raises the messaging fee, which its cap bounds"],
	["message.swapData[0].requiresDeposit", "the Executor ignores it; LI.FI sends true, our builder false"],
	["fuelSwap._transactionId", LABEL],
	["fuelSwap._integrator", LABEL],
	["fuelSwap._referrer", LABEL],
	["fuelSwap._swapData.callTo", INNER_SWAP],
	["fuelSwap._swapData.approveTo", INNER_SWAP],
	["fuelSwap._swapData.callData", INNER_SWAP],
	["fuelSwap._swapData[].callTo", INNER_SWAP],
	["fuelSwap._swapData[].approveTo", INNER_SWAP],
	["fuelSwap._swapData[].callData", INNER_SWAP],
	["fuelSwap._swapData.requiresDeposit", "the router measures its pull from the allowance left, never from this flag"],
	["fuelSwap._swapData[].requiresDeposit", "the router measures its pull from the allowance left, never from this flag"],
	[
		"fuelSwap._swapData[1].fromAmount",
		"the facet returns unswapped input to the router, which joins the token leg; the floor bounds the output",
	],
]

function fieldPattern(field: string): RegExp {
	const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replaceAll("\\[\\]", "\\[\\d+\\]")
	return new RegExp(`^${escaped}$`)
}

const POLICED = ROUTE_FIELD_POLICY.map(([field, kind]) => ({ re: fieldPattern(field), kind }))
const UNPOLICED = ROUTE_UNPOLICED.map(([field, reason]) => ({ re: fieldPattern(field), reason }))

/** How a decoded leaf's path is treated: its rule's kind, its unpoliced reason, or `undefined` for neither. */
export function routeFieldPolicy(path: string): { kind: FieldPolicyKind } | { unpoliced: string } | undefined {
	const policed = POLICED.find((p) => p.re.test(path))
	if (policed) return { kind: policed.kind }
	const listed = UNPOLICED.find((p) => p.re.test(path))
	return listed ? { unpoliced: listed.reason } : undefined
}

class Refused extends Error {
	constructor(
		readonly field: string,
		readonly reason: string,
	) {
		super(`${field}: ${reason}`)
	}
}

function refuse(field: string, reason: string): never {
	throw new Refused(field, reason)
}

function show(v: unknown): string {
	return typeof v === "bigint" ? v.toString() : (JSON.stringify(v) ?? String(v))
}

function same(a: unknown, b: unknown): boolean {
	if (typeof a === "string" && typeof b === "string" && isHex(a) && isHex(b)) return a.toLowerCase() === b.toLowerCase()
	return a === b
}

function eq(field: string, actual: unknown, wanted: unknown): void {
	if (!same(actual, wanted)) refuse(field, `is ${show(actual)}, the policy requires ${show(wanted)}`)
}

function atMost(field: string, actual: bigint, bound: bigint): void {
	if (actual > bound) refuse(field, `is ${actual}, above the policy's ${bound}`)
}

function atLeast(field: string, actual: bigint, bound: bigint): void {
	if (actual < bound) refuse(field, `is ${actual}, below the policy's ${bound}`)
}

function errorText(e: unknown): string {
	return e instanceof Error ? e.message.split("\n")[0] : String(e)
}

function selectorOf(data: Hex): Hex {
	return data.slice(0, 10).toLowerCase() as Hex
}

/** The first path under which `actual` and `wanted` differ, walking `wanted`'s shape (ABI names, array indices). */
function firstDifference(path: string, actual: unknown, wanted: unknown): string | undefined {
	if (Array.isArray(wanted)) {
		if (!Array.isArray(actual) || actual.length !== wanted.length) return `${path}.length`
		return firstOf(wanted.map((w, i) => () => firstDifference(`${path}[${i}]`, actual[i], w)))
	}
	if (typeof wanted === "object" && wanted !== null) {
		const a = (actual ?? {}) as Record<string, unknown>
		return firstOf(
			Object.entries(wanted).map(
				([k, w]) =>
					() =>
						firstDifference(`${path}.${k}`, a[k], w),
			),
		)
	}
	return same(actual, wanted) ? undefined : path
}

function firstOf(diffs: (() => string | undefined)[]): string | undefined {
	for (const diff of diffs) {
		const d = diff()
		if (d) return d
	}
	return undefined
}

function equalTree(path: string, actual: unknown, wanted: unknown): void {
	const d = firstDifference(path, actual, wanted)
	if (d) refuse(d, "differs from our own encoding")
}

/** Positional ABI arguments keyed by their parameter names, the shape every field path uses. */
function named(inputs: readonly { name: string }[], args: readonly unknown[]): Record<string, unknown> {
	return Object.fromEntries(inputs.map((p, i) => [p.name, args[i]]))
}

function bookFor(field: string, chainId: number): LifiChainBook {
	try {
		return lifiBook(chainId)
	} catch (e) {
		return refuse(field, errorText(e))
	}
}

// Each layer decoder checks the selector first and the canonical re-encoding last; a failure names the layer.

function decodeFeeCall(data: Hex) {
	if (selectorOf(data) !== FORWARD_ERC20_FEES_SELECTOR) refuse("fee.selector", `${selectorOf(data)} is not forwardERC20Fees`)
	let args: readonly [Address, readonly { recipient: Address; amount: bigint }[]]
	try {
		args = decodeFunctionData({ abi: FEE_FORWARDER_ABI, data }).args
	} catch (e) {
		return refuse("fee", errorText(e))
	}
	if (encodeFunctionData({ abi: FEE_FORWARDER_ABI, args }) !== data.toLowerCase()) refuse("fee", "non-canonical encoding")
	return { token: args[0], distributions: args[1] }
}

function decodeRouterCall(data: Hex): DecodedRouterCall {
	if (selectorOf(data) !== BRIDGE_FROM_CALLER_SELECTOR) refuse("router.selector", `${selectorOf(data)} is not bridgeFromCaller`)
	let decoded: ReturnType<typeof decodeFunctionData<typeof DEPOSIT_ROUTER_ABI>>
	try {
		decoded = decodeFunctionData({ abi: DEPOSIT_ROUTER_ABI, data })
	} catch (e) {
		return refuse("router", errorText(e))
	}
	if (decoded.functionName !== "bridgeFromCaller") return refuse("router.selector", decoded.functionName)
	const [intent, swapData, minReceived, maxPull] = decoded.args
	if (encodeFunctionData({ abi: DEPOSIT_ROUTER_ABI, functionName: "bridgeFromCaller", args: decoded.args }) !== data.toLowerCase()) {
		refuse("router", "non-canonical encoding")
	}
	return { intent, swapData, minReceived, maxPull }
}

interface FuelSwap {
	selector: Hex
	/** `_swapData` is one tuple in the single entrypoint, an array in the multiple one. */
	single: boolean
	args: Record<string, unknown>
	receiver: Address
	minAmountOut: bigint
	steps: readonly LifiSwapData[]
}

function decodeFuelSwap(data: Hex): FuelSwap {
	const selector = selectorOf(data)
	if (!FUEL_SWAP_SELECTORS.includes(selector)) refuse("fuelSwap.selector", `${selector} is neither pinned swap entrypoint`)
	let decoded: ReturnType<typeof decodeFunctionData<typeof FUEL_SWAP_ABI>>
	try {
		decoded = decodeFunctionData({ abi: FUEL_SWAP_ABI, data })
	} catch (e) {
		return refuse("fuelSwap", errorText(e))
	}
	const reencoded = encodeFunctionData({ abi: FUEL_SWAP_ABI, ...decoded } as Parameters<typeof encodeFunctionData>[0])
	if (reencoded !== data.toLowerCase()) refuse("fuelSwap", "non-canonical encoding")
	const single = decoded.functionName === "swapTokensSingleV3ERC20ToERC20"
	const last = decoded.args[5]
	const steps: readonly LifiSwapData[] = Array.isArray(last) ? last : [last as LifiSwapData]
	const inputs = FUEL_SWAP_ABI[single ? 0 : 1].inputs
	return { selector, single, args: named(inputs, decoded.args), receiver: decoded.args[3], minAmountOut: decoded.args[4], steps }
}

function decodeMessage(bytes: Hex): DecodedMessage & { steps: readonly LifiSwapData[] } {
	let values: readonly [Hex, readonly LifiSwapData[], Address]
	try {
		values = decodeAbiParameters(LIFI_RECEIVER_MESSAGE_PARAMS, bytes)
	} catch (e) {
		return refuse("message", errorText(e))
	}
	if (encodeAbiParameters(LIFI_RECEIVER_MESSAGE_PARAMS, values) !== bytes.toLowerCase()) refuse("message", "non-canonical encoding")
	const [transactionId, steps, receiver] = values
	return { transactionId, steps, step: steps[0], receiver }
}

type StargateData = AbiParameterToPrimitiveType<(typeof STARGATE_FACET_V2_ABI)[1]["inputs"][1]>

type OuterCall =
	| { rail: "acrossV4"; bridgeData: LifiBridgeData; acrossData: AcrossV4Data }
	| { rail: "stargateV2"; bridgeData: LifiBridgeData; swaps?: readonly LifiSwapData[]; stargate: StargateData }

function decodeOuterCall(data: Hex, rail: RailExpectation["kind"], src: LifiChainBook): OuterCall {
	const selector = selectorOf(data)
	if (!RAIL_SELECTORS[rail].includes(selector) || !(selector in src.facets)) {
		refuse("call.selector", `${selector} is not a ${rail} entrypoint this app accepts on chain ${src.chainId}`)
	}
	const abi = rail === "acrossV4" ? ACROSS_V4_FACET_ABI : STARGATE_FACET_V2_ABI
	let decoded: ReturnType<typeof decodeFunctionData<typeof abi>>
	try {
		decoded = decodeFunctionData({ abi, data })
	} catch (e) {
		return refuse("call", errorText(e))
	}
	const reencoded = encodeFunctionData({ abi, ...decoded } as Parameters<typeof encodeFunctionData>[0])
	if (reencoded !== data.toLowerCase()) refuse("call", "non-canonical encoding")
	switch (decoded.functionName) {
		case "startBridgeTokensViaAcrossV4":
			return { rail: "acrossV4", bridgeData: decoded.args[0], acrossData: decoded.args[1] }
		case "swapAndStartBridgeTokensViaStargate":
			return { rail: "stargateV2", bridgeData: decoded.args[0], swaps: decoded.args[1], stargate: decoded.args[2] }
		default:
			return { rail: "stargateV2", bridgeData: decoded.args[0], stargate: decoded.args[1] }
	}
}

/** Our own router call, decoded and held to the fuel policy: the bytes every route's destination step must equal. */
function checkOurRouterCall(x: RouteExpectation): DecodedRouterCall & { fuelSwap?: FuelSwap } {
	const ours = decodeRouterCall(x.routerCall)
	eq("router.intent.token", ours.intent.token, x.destToken)
	if (ours.intent.fuelSlice === 0n) {
		eq("router.swapData", ours.swapData, "0x")
		return ours
	}
	checkFuelProvider(x)
	const fuelSwap = decodeFuelSwap(ours.swapData)
	eq("fuelSwap._receiver", fuelSwap.receiver, x.router)
	eq("fuelSwap._minAmountOut", fuelSwap.minAmountOut, ours.intent.minFuelOutput)
	checkFuelSteps(fuelSwap, ours.intent, x)
	return { ...ours, fuelSwap }
}

function checkFuelProvider(x: RouteExpectation): void {
	const fuel = x.fuel
	if (fuel?.provider === "lifi") {
		// The venue is an API field: only venues proven to survive a late fill pass, and the router's floor binds whatever runs.
		if (!(LIFI_ALLOW_EXCHANGES as readonly string[]).includes(fuel.tool))
			refuse("fuel.tool", `venue "${fuel.tool}" is not a proven venue`)
	} else if (fuel?.provider === "testnetSwapper") {
		if (x.l1ChainId === 1) refuse("fuel.provider", "TestnetFuelSwapper never serves mainnet")
	} else {
		refuse("fuel.provider", "a fuel slice needs the provider of the quote it embeds")
	}
}

/** One optional non-asset-changing step (LI.FI's fee) then exactly one swap into the fee asset. */
function checkFuelSteps(swap: FuelSwap, intent: RouterIntent, x: RouteExpectation): void {
	const at = (i: number, k: string) => (swap.single ? `fuelSwap._swapData.${k}` : `fuelSwap._swapData[${i}].${k}`)
	const steps = swap.steps
	// The facet returns each step's leftover input to `_receiver`, so a longer route would strand intermediates there.
	if (steps.length < 1 || steps.length > 2) refuse("fuelSwap._swapData.length", `${steps.length} steps; at most a fee step and one swap`)
	eq(at(0, "sendingAssetId"), steps[0].sendingAssetId, x.destToken)
	eq(at(0, "fromAmount"), steps[0].fromAmount, intent.fuelSlice)
	for (const [i, s] of steps.entries()) {
		if (i > 0) eq(at(i, "sendingAssetId"), s.sendingAssetId, steps[i - 1].receivingAssetId)
		eq(at(i, "receivingAssetId"), s.receivingAssetId, i === steps.length - 1 ? x.feeAsset : s.sendingAssetId)
	}
}

function checkEnvelope(tx: RouteTx, x: RouteExpectation, src: LifiChainBook): void {
	eq("tx.chainId", tx.chainId, x.srcChainId)
	eq("tx.from", tx.from, x.user)
	eq("tx.to", tx.to, src.diamond)
	eq("approval.token", tx.approval.token, x.srcToken)
	eq("approval.spender", tx.approval.spender, src.diamond)
	eq("approval.amount", tx.approval.amount, x.srcAmount)
}

/** Every `BridgeData` field but `minAmount`, which waits for the fee step. */
function checkBridgeData(b: LifiBridgeData, hasSourceSwaps: boolean, x: RouteExpectation): void {
	const f = (k: keyof LifiBridgeData) => `call._bridgeData.${k}`
	eq(f("transactionId"), b.transactionId, x.lifiTxId)
	eq(f("integrator"), b.integrator, LIFI_INTEGRATOR)
	eq(f("sendingAssetId"), b.sendingAssetId, x.srcToken)
	eq(f("receiver"), b.receiver, x.user)
	eq(f("destinationChainId"), b.destinationChainId, BigInt(x.l1ChainId))
	eq(f("hasSourceSwaps"), b.hasSourceSwaps, hasSourceSwaps)
	eq(f("hasDestinationCall"), b.hasDestinationCall, true)
}

/** LI.FI's fee step, the only source swap a route may carry; returns the fee it takes. */
function checkSourceSwaps(swaps: readonly LifiSwapData[], x: RouteExpectation, src: LifiChainBook): bigint {
	eq("call._swapData.length", swaps.length, 1)
	const s = swaps[0]
	const f = (k: keyof LifiSwapData) => `call._swapData[0].${k}`
	eq(f("callTo"), s.callTo, src.feeForwarder)
	eq(f("approveTo"), s.approveTo, src.feeForwarder)
	eq(f("sendingAssetId"), s.sendingAssetId, x.srcToken)
	eq(f("receivingAssetId"), s.receivingAssetId, x.srcToken)
	eq(f("fromAmount"), s.fromAmount, x.srcAmount)
	eq(f("requiresDeposit"), s.requiresDeposit, true)
	const fee = decodeFeeCall(s.callData)
	eq("fee._token", fee.token, x.srcToken)
	eq("fee._distributions.length", fee.distributions.length, 1)
	const amount = fee.distributions[0].amount
	if (amount * 10_000n > x.srcAmount * LIFI_FEE_CAP_BPS) refuse("fee._distributions[0].amount", `${amount} exceeds LI.FI's 0.25 %`)
	return amount
}

interface RailFacts {
	message: Hex
	fromAmount: { min: bigint; max: bigint }
	value: bigint
}

/**
 * The Across inputs our builder signs for this expectation: the testnet rail's only builder, so the app builds with
 * it and `verifyRoute` compares against it. Throws when the expectation is not an Across one or names an unbooked chain.
 */
export function acrossDepositFor(x: RouteExpectation): AcrossV4DepositParams {
	if (x.rail.kind !== "acrossV4") throw new Error("lifi-decode: not an Across expectation")
	const { outputAmount, quoteTimestamp, fillDeadline } = x.rail
	return {
		diamond: lifiBook(x.srcChainId).diamond,
		transactionId: x.lifiTxId,
		integrator: LIFI_INTEGRATOR,
		user: x.user,
		inputToken: x.srcToken,
		inputAmount: x.srcAmount,
		destinationChainId: BigInt(x.l1ChainId),
		destinationReceiver: lifiBook(x.l1ChainId).receiverAcrossV4,
		outputToken: x.destToken,
		outputAmount,
		quoteTimestamp,
		fillDeadline,
		steps: [
			{
				callTo: x.router,
				approveTo: x.router,
				sendingAssetId: x.destToken,
				receivingAssetId: x.destToken,
				// Across delivers exactly `outputAmount`.
				fromAmount: outputAmount,
				callData: x.routerCall,
				requiresDeposit: false,
			},
		],
	}
}

const ACROSS_POLICED = ACROSS_V4_DATA_COMPONENTS.map((c) => c.name).filter((k) => k !== "message")

/** Every `AcrossV4Data` field but the message equals our builder's; the message has its own policy. */
function checkAcross(actual: AcrossV4Data, x: RouteExpectation): RailFacts {
	let wanted: AcrossV4Data
	try {
		wanted = acrossV4Call(acrossDepositFor(x)).acrossData
	} catch (e) {
		return refuse("expected.rail", errorText(e))
	}
	for (const k of ACROSS_POLICED) eq(`call._acrossData.${k}`, actual[k], wanted[k])
	return { message: actual.message, fromAmount: { min: wanted.outputAmount, max: wanted.outputAmount }, value: 0n }
}

function checkOptions(options: Hex): LzExecutorOption[] {
	let decoded: LzExecutorOption[]
	try {
		decoded = decodeLzOptions(options)
	} catch (e) {
		return refuse("options", errorText(e))
	}
	const compose = decoded.filter((o) => o.kind === "lzCompose")
	eq("options.lzCompose.length", compose.length, 1)
	eq("options.lzCompose[0].index", compose[0].index, 0)
	atLeast("options.lzCompose[0].gas", compose[0].gas, LIFI_MIN_COMPOSE_GAS)
	eq("options.lzCompose[0].value", compose[0].value, 0n)
	for (const [i, o] of decoded.filter((o) => o.kind === "lzReceive").entries()) eq(`options.lzReceive[${i}].value`, o.value, 0n)
	eq("options.nativeDrop.length", decoded.filter((o) => o.kind === "nativeDrop").length, 0)
	eq("options.orderedExecution.length", decoded.filter((o) => o.kind === "orderedExecution").length, 0)
	return decoded
}

interface StargateContext {
	x: RouteExpectation & { rail: { kind: "stargateV2" } }
	src: LifiChainBook
	dst: LifiChainBook
	bridged: bigint
	/** `T`: our router call's `minReceived`, which Stargate's own floor must cover. */
	minReceived: bigint
}

function checkStargate(sg: StargateData, c: StargateContext): RailFacts & { options: LzExecutorOption[] } {
	const f = (k: string) => `call._stargateData.${k}`
	const pool = stargatePoolFor(c.src, c.x.srcToken)
	if (!pool) return refuse(f("assetId"), `no pinned Stargate pool for ${c.x.srcToken} on chain ${c.src.chainId}`)
	eq(f("assetId"), sg.assetId, pool.assetId)
	const s = sg.sendParams
	const { layerZero, receiverStargateV2 } = c.dst
	if (!layerZero || !receiverStargateV2) return refuse(f("sendParams.dstEid"), `no Stargate destination on chain ${c.dst.chainId}`)
	eq(f("sendParams.dstEid"), s.dstEid, layerZero.eid)
	eq(f("sendParams.to"), s.to, pad(receiverStargateV2, { size: 32 }))
	eq(f("sendParams.amountLD"), s.amountLD, c.bridged)
	atLeast(f("sendParams.minAmountLD"), s.minAmountLD, c.minReceived)
	const options = checkOptions(s.extraOptions)
	eq(f("sendParams.oftCmd"), s.oftCmd, "0x")
	atMost(f("fee.nativeFee"), sg.fee.nativeFee, c.x.rail.maxNativeFee)
	eq(f("fee.lzTokenFee"), sg.fee.lzTokenFee, 0n)
	eq(f("refundAddress"), sg.refundAddress, c.x.user)
	return { message: s.composeMsg, fromAmount: { min: c.minReceived, max: s.minAmountLD }, value: sg.fee.nativeFee, options }
}

/** The destination message: one step, into our router, carrying exactly our call; the user is the fallback. */
function checkMessage(bytes: Hex, x: RouteExpectation, fromAmount: RailFacts["fromAmount"], ours: ReturnType<typeof checkOurRouterCall>) {
	const m = decodeMessage(bytes)
	eq("message.transactionId", m.transactionId, x.lifiTxId)
	eq("message.swapData.length", m.steps.length, 1)
	const f = (k: keyof LifiSwapData) => `message.swapData[0].${k}`
	eq(f("callTo"), m.step.callTo, x.router)
	eq(f("approveTo"), m.step.approveTo, x.router)
	eq(f("sendingAssetId"), m.step.sendingAssetId, x.destToken)
	eq(f("receivingAssetId"), m.step.receivingAssetId, x.destToken)
	// Above what certainly arrives, the Executor's balance check fails and the whole delivery recovers.
	if (m.step.fromAmount < fromAmount.min || m.step.fromAmount > fromAmount.max) {
		refuse(f("fromAmount"), `${m.step.fromAmount} is outside [${fromAmount.min}, ${fromAmount.max}]`)
	}
	checkRouterCallBytes(m.step.callData, ours, x)
	eq("message.receiver", m.receiver, x.user)
	return { transactionId: m.transactionId, step: m.step, receiver: m.receiver }
}

/** The step's calldata equals our encoding, compared leaf by leaf first so a difference is named. */
function checkRouterCallBytes(data: Hex, ours: ReturnType<typeof checkOurRouterCall>, x: RouteExpectation): void {
	const actual = decodeRouterCall(data)
	equalTree("router.intent", actual.intent, ours.intent)
	if (ours.fuelSwap && actual.swapData !== "0x") {
		const swap = decodeFuelSwap(actual.swapData)
		eq("fuelSwap.selector", swap.selector, ours.fuelSwap.selector)
		equalTree("fuelSwap", swap.args, ours.fuelSwap.args)
	}
	eq("router.swapData", actual.swapData, ours.swapData)
	eq("router.minReceived", actual.minReceived, ours.minReceived)
	eq("router.maxPull", actual.maxPull, ours.maxPull)
	eq("message.swapData[0].callData", data, x.routerCall)
}

function checkRoute(tx: RouteTx, x: RouteExpectation): DecodedRoute {
	const src = bookFor("expected.srcChainId", x.srcChainId)
	const dst = bookFor("expected.l1ChainId", x.l1ChainId)
	const ours = checkOurRouterCall(x)
	checkEnvelope(tx, x, src)
	const call = decodeOuterCall(tx.data, x.rail.kind, src)
	const swaps = call.rail === "stargateV2" ? call.swaps : undefined
	checkBridgeData(call.bridgeData, swaps !== undefined, x)
	const lifiFee = swaps ? checkSourceSwaps(swaps, x, src) : 0n
	eq("call._bridgeData.minAmount", call.bridgeData.minAmount, x.srcAmount - lifiFee)
	let facts: RailFacts
	let stargate: DecodedRoute["stargate"]
	if (call.rail === "acrossV4") {
		facts = checkAcross(call.acrossData, x)
	} else {
		if (x.rail.kind !== "stargateV2") return refuse("call.selector", "a Stargate call for an Across expectation")
		const context = { x: { ...x, rail: x.rail }, src, dst, bridged: call.bridgeData.minAmount, minReceived: ours.minReceived }
		const sg = checkStargate(call.stargate, context)
		facts = sg
		stargate = {
			assetId: call.stargate.assetId,
			minAmountLD: call.stargate.sendParams.minAmountLD,
			nativeFee: sg.value,
			options: sg.options,
		}
	}
	eq("tx.value", tx.value, facts.value)
	const message = checkMessage(facts.message, x, facts.fromAmount, ours)
	const { fuelSwap: _, ...router } = ours
	return {
		rail: call.rail,
		bridgeData: call.bridgeData,
		lifiFee,
		across: call.rail === "acrossV4" ? call.acrossData : undefined,
		stargate,
		message,
		router,
	}
}

function verdict<T>(run: () => T): { ok: true; decoded: T } | RouteRefusal {
	try {
		return { ok: true, decoded: run() }
	} catch (e) {
		if (e instanceof Refused) return { ok: false, field: e.field, reason: e.reason }
		return { ok: false, field: "route", reason: errorText(e) }
	}
}

/**
 * Verifies the exact source transaction against `expected` before anything is signed: on the bytes shown at
 * Review and again right before the wallet prompt. Pure: no I/O; the caller reads the Stargate fee ceiling first.
 *
 * Refuses (never throws) with the first field outside its policy, in check order: the envelope and approval, the
 * facet call (an API-authored Across route, or any entrypoint the source chain's book does not accept, is refused),
 * `BridgeData`, LI.FI's fee step, the rail's own data, the destination message, and our router call inside it.
 */
export function verifyRoute(tx: RouteTx, expected: RouteExpectation): RouteVerdict {
	return verdict(() => checkRoute(tx, expected))
}

/**
 * Verifies what EndpointV2 delivers to ReceiverStargateV2's `lzCompose` for a Stargate route: sent by the source
 * chain's pinned Diamond from its pinned endpoint id, carrying a destination message that passes the same policy,
 * with the step's `fromAmount` within `[T, amountLD]`.
 */
export function verifyComposeMessage(message: Hex, expected: RouteExpectation): ComposeVerdict {
	return verdict(() => {
		const src = bookFor("expected.srcChainId", expected.srcChainId)
		if (expected.rail.kind !== "stargateV2" || !src.layerZero) return refuse("expected.rail", "not a Stargate route")
		const ours = checkOurRouterCall(expected)
		let compose: OftComposeMessage
		try {
			compose = decodeOftComposeMessage(message)
		} catch (e) {
			return refuse("compose", errorText(e))
		}
		eq("compose.srcEid", compose.srcEid, src.layerZero.eid)
		eq("compose.composeFrom", compose.composeFrom, pad(src.diamond, { size: 32 }))
		const decoded = checkMessage(compose.composeMsg, expected, { min: ours.minReceived, max: compose.amountLD }, ours)
		return { compose, message: decoded }
	})
}
