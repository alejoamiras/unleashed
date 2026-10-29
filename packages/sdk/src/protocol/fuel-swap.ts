/**
 * The gas leg's swap: what the call the router hands its `SWAP_TARGET` may contain, decided from its exact bytes. One
 * rule for every caller (the SDK's quote, `verifyRoute`), so a deposit's signed swap and a route's delivered one meet
 * the same pins. Field names are `verifyRoute`'s policy paths. Pure: no I/O, never throws.
 */
import { type Address, decodeFunctionData, encodeFunctionData, type Hex, toFunctionSelector } from "viem"
import { FUEL_SWAP_SELECTORS, type LifiSwapData, SWAP_TOKENS_MULTIPLE_V3_ABI, SWAP_TOKENS_SINGLE_V3_ABI } from "./lifi-abi.ts"
import { lifiBook } from "./lifi-addresses.ts"
import { LIFI_ALLOW_EXCHANGES, LIFI_FUEL_CHAIN_IDS } from "./lifi-gas.ts"

/** LI.FI's own fee on the fee tier: at most 0.25 % of the input. Our integrator fee is 0, so no second share exists. */
export const LIFI_FEE_CAP_BPS = 25n

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

export const FORWARD_ERC20_FEES_SELECTOR: Hex = toFunctionSelector(FEE_FORWARDER_ABI[0])

const FUEL_SWAP_ABI = [...SWAP_TOKENS_SINGLE_V3_ABI, ...SWAP_TOKENS_MULTIPLE_V3_ABI] as const

/** The first leaf outside the policy, by its policy path. */
export interface FuelSwapIssue {
	field: string
	reason: string
}

export interface FeeCall {
	token: Address
	distributions: readonly { recipient: Address; amount: bigint }[]
	/** Keyed by ABI name (`_token`, `_distributions`), the shape every field path uses. */
	args: Record<string, unknown>
}

export interface FuelSwap {
	selector: Hex
	/** `_swapData` is one tuple in the single entrypoint, an array in the multiple one. */
	single: boolean
	/** Keyed by ABI name, the shape every field path uses. */
	args: Record<string, unknown>
	receiver: Address
	minAmountOut: bigint
	steps: readonly LifiSwapData[]
}

/** The venue a quote names: LI.FI's tool, or the manifest's testnet swapper (required; a missing one is refused). */
export type FuelSwapVenue = { provider: "lifi"; tool: string } | { provider: "testnetSwapper"; swapper?: Address }

/** What the swap must do, from the router's intent and the manifest; the provider's tool only picks a pinned venue. */
export interface FuelSwapExpectation {
	/** The router's L1, whose LI.FI book pins the fee and venue steps. */
	chainId: number
	/** The intent's token, which the slice is paid in. */
	token: Address
	slice: bigint
	feeAsset: Address
	venue: FuelSwapVenue
}

const selectorOf = (data: Hex) => data.slice(0, 10).toLowerCase() as Hex
const errorText = (e: unknown) => (e instanceof Error ? e.message.split("\n")[0] : String(e))
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const named = (inputs: readonly { name: string }[], args: readonly unknown[]) => Object.fromEntries(inputs.map((p, i) => [p.name, args[i]]))

/** `forwardERC20Fees` calldata, or the `<prefix>.` field that is not its canonical encoding. */
export function decodeFeeCall(data: Hex, prefix: string): FeeCall | FuelSwapIssue {
	if (selectorOf(data) !== FORWARD_ERC20_FEES_SELECTOR)
		return { field: `${prefix}.selector`, reason: `${selectorOf(data)} is not forwardERC20Fees` }
	let args: readonly [Address, readonly { recipient: Address; amount: bigint }[]]
	try {
		args = decodeFunctionData({ abi: FEE_FORWARDER_ABI, data }).args
	} catch (e) {
		return { field: prefix, reason: errorText(e) }
	}
	if (encodeFunctionData({ abi: FEE_FORWARDER_ABI, args }) !== data.toLowerCase())
		return { field: prefix, reason: "non-canonical encoding" }
	return { token: args[0], distributions: args[1], args: named(FEE_FORWARDER_ABI[0].inputs, args) }
}

/** One of the two pinned swap entrypoints, canonically encoded, or the `fuelSwap` field that is not. */
export function decodeFuelSwap(data: Hex): FuelSwap | FuelSwapIssue {
	const selector = selectorOf(data)
	if (!FUEL_SWAP_SELECTORS.includes(selector))
		return { field: "fuelSwap.selector", reason: `${selector} is neither pinned swap entrypoint` }
	let decoded: ReturnType<typeof decodeFunctionData<typeof FUEL_SWAP_ABI>>
	try {
		decoded = decodeFunctionData({ abi: FUEL_SWAP_ABI, data })
	} catch (e) {
		return { field: "fuelSwap", reason: errorText(e) }
	}
	const reencoded = encodeFunctionData({ abi: FUEL_SWAP_ABI, ...decoded } as Parameters<typeof encodeFunctionData>[0])
	if (reencoded !== data.toLowerCase()) return { field: "fuelSwap", reason: "non-canonical encoding" }
	const single = decoded.functionName === "swapTokensSingleV3ERC20ToERC20"
	const last = decoded.args[5]
	const steps: readonly LifiSwapData[] = Array.isArray(last) ? last : [last as LifiSwapData]
	const inputs = FUEL_SWAP_ABI[single ? 0 : 1].inputs
	return { selector, single, args: named(inputs, decoded.args), receiver: decoded.args[3], minAmountOut: decoded.args[4], steps }
}

/** The fee step's call, when the swap has one (LI.FI's first of two steps). */
export function fuelFeeCall(swap: FuelSwap): FeeCall | FuelSwapIssue | undefined {
	return swap.steps.length === 2 ? decodeFeeCall(swap.steps[0].callData, "fuelFee") : undefined
}

type Check = readonly [field: string, actual: unknown, wanted: unknown]

function firstMismatch(checks: readonly Check[]): FuelSwapIssue | undefined {
	for (const [field, actual, wanted] of checks) {
		const ok = typeof actual === "string" && typeof wanted === "string" ? same(actual, wanted) : actual === wanted
		if (!ok) return { field, reason: `is ${String(actual)}, the policy requires ${String(wanted)}` }
	}
	return undefined
}

function feeStepIssue(step: LifiSwapData, fee: FeeCall, x: FuelSwapExpectation, forwarder: Address): FuelSwapIssue | undefined {
	const at = (k: string) => `fuelSwap._swapData[0].${k}`
	const amount = fee.distributions[0]?.amount ?? 0n
	return (
		firstMismatch([
			[at("callTo"), step.callTo, forwarder],
			[at("approveTo"), step.approveTo, forwarder],
			[at("sendingAssetId"), step.sendingAssetId, x.token],
			[at("receivingAssetId"), step.receivingAssetId, x.token],
			[at("fromAmount"), step.fromAmount, x.slice],
			["fuelFee._token", fee.token, x.token],
			["fuelFee._distributions.length", fee.distributions.length, 1],
		]) ??
		(amount * 10_000n > x.slice * LIFI_FEE_CAP_BPS
			? { field: "fuelFee._distributions[0].amount", reason: `${amount} exceeds LI.FI's 0.25 % of ${x.slice}` }
			: undefined)
	)
}

function swapStepIssue(step: LifiSwapData, at: (k: string) => string, x: FuelSwapExpectation, venue: Address, fee: bigint) {
	return firstMismatch([
		[at("callTo"), step.callTo, venue],
		[at("approveTo"), step.approveTo, venue],
		[at("sendingAssetId"), step.sendingAssetId, x.token],
		[at("receivingAssetId"), step.receivingAssetId, x.feeAsset],
		[at("fromAmount"), step.fromAmount, x.slice - fee],
	])
}

function venueOf(x: FuelSwapExpectation): Address | FuelSwapIssue {
	if (x.venue.provider === "testnetSwapper") {
		if (x.chainId === 1) return { field: "fuel.provider", reason: "TestnetFuelSwapper never serves mainnet" }
		return x.venue.swapper ?? { field: "expected.fuelSwapper", reason: "a testnet swapper's quote needs the manifest's swapper" }
	}
	const { tool } = x.venue
	const venues = lifiBook(x.chainId).fuelVenues
	if (!(LIFI_ALLOW_EXCHANGES as readonly string[]).includes(tool) || !Object.hasOwn(venues, tool))
		return { field: "fuel.tool", reason: `venue "${tool}" is not a proven venue on chain ${x.chainId}` }
	return venues[tool]
}

/**
 * The first leaf of `swap` outside the gas leg's policy, or undefined. LI.FI: at most two steps, LI.FI's fee step
 * (`FeeForwarder`, one share of at most `LIFI_FEE_CAP_BPS`) then the named venue's pinned contract swapping exactly
 * the slice less that fee into the fee asset, and only on `LIFI_FUEL_CHAIN_IDS`. The testnet swapper: one step at the
 * manifest's swapper. The venue step's own calldata is not read. `receiver` and `minAmountOut` are the caller's to
 * compare. Never throws: an unbooked chain is a refusal.
 */
export function fuelSwapIssue(swap: FuelSwap, x: FuelSwapExpectation): FuelSwapIssue | undefined {
	let venue: Address | FuelSwapIssue
	try {
		venue = venueOf(x)
	} catch (e) {
		return { field: "expected.l1ChainId", reason: errorText(e) }
	}
	if (typeof venue === "object") return venue
	const steps = swap.steps
	const lifi = x.venue.provider === "lifi"
	// The facet returns each step's leftover input to `_receiver`, so a longer route would strand intermediates there.
	if (steps.length < 1 || steps.length > (lifi ? 2 : 1)) return { field: "fuelSwap._swapData.length", reason: `${steps.length} steps` }
	let fee = 0n
	if (steps.length === 2) {
		const call = fuelFeeCall(swap) as FeeCall | FuelSwapIssue
		if (!("token" in call)) return call
		const issue = feeStepIssue(steps[0], call, x, lifiBook(x.chainId).feeForwarder)
		if (issue) return issue
		fee = call.distributions[0].amount
	}
	const last = steps.length - 1
	const at = (k: string) => (swap.single ? `fuelSwap._swapData.${k}` : `fuelSwap._swapData[${last}].${k}`)
	const issue = swapStepIssue(steps[last], at, x, venue, fee)
	if (issue) return issue
	// Last, so that where LI.FI gas swaps are enabled every leaf above is still refused under its own name.
	if (lifi && !LIFI_FUEL_CHAIN_IDS.includes(x.chainId))
		return { field: "fuel.provider", reason: `LI.FI gas swaps are not enabled on chain ${x.chainId}` }
	return undefined
}
