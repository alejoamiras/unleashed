/**
 * Off-chain fuel quoting: chained single-hop `quoteExactInputSingle` eth_calls against the
 * canonical V4 Quoter (the quoter is `nonpayable` BY DESIGN — it uses transient state — so
 * quoting goes through eth_call simulation, zero gas). The quote is DISPLAY + floor input
 * only; the on-chain bound is the signed `minFuelOutput`, and the claim side must always
 * use the event-sourced `fuelReceived`, never this estimate.
 */
import { type Address, decodeFunctionResult, encodeFunctionData, type Hex } from "viem"
import type { PoolKey } from "./l1"
import type { FuelRoute } from "./route"

export const QUOTER_ABI = [
	{
		type: "function",
		name: "quoteExactInputSingle",
		stateMutability: "nonpayable",
		inputs: [
			{
				name: "params",
				type: "tuple",
				components: [
					{
						name: "poolKey",
						type: "tuple",
						components: [
							{ name: "currency0", type: "address" },
							{ name: "currency1", type: "address" },
							{ name: "fee", type: "uint24" },
							{ name: "tickSpacing", type: "int24" },
							{ name: "hooks", type: "address" },
						],
					},
					{ name: "zeroForOne", type: "bool" },
					{ name: "exactAmount", type: "uint128" },
					{ name: "hookData", type: "bytes" },
				],
			},
		],
		outputs: [
			{ name: "amountOut", type: "uint256" },
			{ name: "gasEstimate", type: "uint256" },
		],
	},
] as const

/** The viem surface this module needs — a PublicClient satisfies it. */
export interface QuoteClient {
	readContract(args: {
		address: Address
		abi: typeof QUOTER_ABI
		functionName: "quoteExactInputSingle"
		args: readonly [
			{
				poolKey: PoolKey
				zeroForOne: boolean
				exactAmount: bigint
				hookData: `0x${string}`
			},
		]
	}): Promise<readonly [bigint, bigint]>
}

/** Thrown when the route cannot currently produce output (no pool, no liquidity, dust). */
export class QuoteUnavailableError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options)
		this.name = "QuoteUnavailableError"
	}
}

/** Chains per-hop quotes (each hop's output feeds the next); returns the expected FJ out. */
export async function quoteFuelPath(client: QuoteClient, quoter: Address, route: FuelRoute, amountIn: bigint): Promise<bigint> {
	if (amountIn <= 0n) throw new QuoteUnavailableError("Quote requires a positive input amount.")
	let current = amountIn
	for (let i = 0; i < route.path.length; i++) {
		try {
			const [amountOut] = await client.readContract({
				address: quoter,
				abi: QUOTER_ABI,
				functionName: "quoteExactInputSingle",
				args: [{ poolKey: route.path[i], zeroForOne: route.zeroForOnes[i], exactAmount: current, hookData: "0x" }],
			})
			current = amountOut
		} catch (e) {
			throw new QuoteUnavailableError(`No route available through hop ${i + 1} right now.`, { cause: e })
		}
		if (current <= 0n) throw new QuoteUnavailableError(`Hop ${i + 1} quotes to zero — amount too small or pool drained.`)
	}
	return current
}

/**
 * Multicall3's `aggregate3`. Declared `view` although the deployed function is `payable`: the
 * selector derives from name + input types only, so the stated mutability is inert for encoding,
 * and `view` is the shape a viem `readContract` accepts. Value is never sent — quoting is eth_call.
 */
const MULTICALL3_ABI = [
	{
		type: "function",
		name: "aggregate3",
		stateMutability: "view",
		inputs: [
			{
				name: "calls",
				type: "tuple[]",
				components: [
					{ name: "target", type: "address" },
					{ name: "allowFailure", type: "bool" },
					{ name: "callData", type: "bytes" },
				],
			},
		],
		outputs: [
			{
				name: "returnData",
				type: "tuple[]",
				components: [
					{ name: "success", type: "bool" },
					{ name: "returnData", type: "bytes" },
				],
			},
		],
	},
] as const

/** The viem surface batching needs — a PublicClient satisfies it. */
export interface BatchQuoteClient {
	readContract(args: {
		address: Address
		abi: typeof MULTICALL3_ABI
		functionName: "aggregate3"
		args: readonly [readonly { target: Address; allowFailure: boolean; callData: Hex }[]]
	}): Promise<readonly { success: boolean; returnData: Hex }[]>
}

/** Per-route batch outcome. A failing route never fails its neighbours — `allowFailure` is on. */
export type BatchedQuote = { out: bigint } | { error: string }

function encodeHopCall(quoter: Address, route: FuelRoute, hop: number, amountIn: bigint) {
	return {
		target: quoter,
		allowFailure: true,
		callData: encodeFunctionData({
			abi: QUOTER_ABI,
			functionName: "quoteExactInputSingle",
			args: [{ poolKey: route.path[hop], zeroForOne: route.zeroForOnes[hop], exactAmount: amountIn, hookData: "0x" }],
		}),
	}
}

/** The hop's output amount, or the reason this route is out of the running. */
function readHopOutput(entry: { success: boolean; returnData: Hex } | undefined, hop: number): bigint | string {
	if (entry === undefined || !entry.success) return `Hop ${hop + 1} reverted — no such pool.`
	try {
		const [amountOut] = decodeFunctionResult({ abi: QUOTER_ABI, functionName: "quoteExactInputSingle", data: entry.returnData })
		if (amountOut <= 0n) return `Hop ${hop + 1} quotes to zero — amount too small or pool has no liquidity.`
		return amountOut
	} catch (e) {
		return `Hop ${hop + 1} returned undecodable data: ${String(e)}`
	}
}

/**
 * Quotes many routes in as few round-trips as there are hops. Each hop's input is the previous
 * hop's output, so hops cannot share a batch — hop N of every still-live route goes out in one
 * `aggregate3`, then hop N+1 of the survivors. A throw here is transport failure (the whole
 * multicall), never a dead pool: those come back as per-route `error` entries.
 */
export async function quoteFuelPathsBatched(
	client: BatchQuoteClient,
	quoter: Address,
	multicall3: Address,
	routes: FuelRoute[],
	amountIn: bigint,
): Promise<BatchedQuote[]> {
	if (amountIn <= 0n) throw new QuoteUnavailableError("Quote requires a positive input amount.")
	const settled: (BatchedQuote | undefined)[] = routes.map((r) =>
		r.path.length > 0 && r.path.length === r.zeroForOnes.length
			? undefined
			: { error: "Route is empty or its path and directions disagree." },
	)
	const amounts = routes.map(() => amountIn)
	const depth = routes.reduce((d, r) => Math.max(d, r.path.length), 0)

	for (let hop = 0; hop < depth; hop++) {
		const live = routes.map((_, i) => i).filter((i) => settled[i] === undefined && hop < routes[i].path.length)
		if (live.length === 0) break
		const returned = await client.readContract({
			address: multicall3,
			abi: MULTICALL3_ABI,
			functionName: "aggregate3",
			args: [live.map((i) => encodeHopCall(quoter, routes[i], hop, amounts[i]))],
		})
		live.forEach((routeIdx, slot) => {
			const outcome = readHopOutput(returned[slot], hop)
			if (typeof outcome === "string") settled[routeIdx] = { error: outcome }
			else amounts[routeIdx] = outcome
		})
	}
	// A route that ran out of hops before `depth` was never marked settled; its last output stands.
	return settled.map((s, i) => s ?? { out: amounts[i] })
}

/** The signed slippage floor: quote minus `bps` (e.g. 300 = 3%). Never 0 — a zero floor signs the slice away. */
export function minOutputForSlippage(quote: bigint, bps: number): bigint {
	if (quote <= 0n) throw new QuoteUnavailableError("Cannot derive a floor from an empty quote.")
	if (bps < 0 || bps >= 10_000) throw new Error("minOutputForSlippage: bps out of range")
	const floor = (quote * BigInt(10_000 - bps)) / 10_000n
	return floor > 0n ? floor : 1n
}
