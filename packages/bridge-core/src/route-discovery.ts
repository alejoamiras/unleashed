/**
 * Fuel-route discovery: probe every candidate pool shape with ONE batched dust quote and keep the
 * best. "Initialized" is not "liquid" — a pool that exists but holds nothing quotes zero, which is
 * a no-route, not a failure. The two outcomes drive different UI (pick another token vs. retry),
 * so only a dead transport is `unavailable`.
 */
import type { Address } from "viem"
import type { PoolKey } from "./l1"
import { type BatchedQuote, type BatchQuoteClient, quoteFuelPathsBatched } from "./quote"
import { buildFuelRoute, type FuelPoolParams, type FuelRoute } from "./route"

const NATIVE = "0x0000000000000000000000000000000000000000" as Address

export type RouteOutcome =
	| { kind: "route"; route: FuelRoute; quoteOut: bigint }
	| { kind: "identity" }
	| { kind: "no-route"; tried: number }
	| { kind: "unavailable"; reason: "rpc" | "config" }

export interface DiscoverRouteOptions {
	client: BatchQuoteClient
	quoter: Address
	multicall3: Address
	token: Address
	/** The L1 FeeJuice ERC-20: bridging it needs no swap at all. */
	feeAsset: Address
	weth: Address
	feeJuice: Address
	/** TOKEN/WETH tiers to probe, in preference order — an exact output tie keeps the earlier one. */
	tiers: FuelPoolParams[]
	ethFj: FuelPoolParams
	/** Dust in the token's base units: big enough to survive rounding, small enough not to move the pool. */
	probeAmount: bigint
}

const same = (a: Address, b: Address) => a.toLowerCase() === b.toLowerCase()

/**
 * `UniswapFuelSwap._validateRoute`, restated. Every candidate passes through here BEFORE it can be
 * quoted or witness-signed: a malformed route that reaches Permit2 costs the user a signature and
 * reverts on L1. Messages are the contract's own require strings so a local failure greps straight
 * to the rule it broke.
 */
export function assertRouteGrammar(route: FuelRoute, inputToken: Address, weth: Address, feeJuice: Address): void {
	const { path, zeroForOnes } = route
	if (path.length === 0) throw new Error("UniswapFuelSwap: empty path")
	if (path.length !== zeroForOnes.length) throw new Error("UniswapFuelSwap: path/direction mismatch")

	const firstInput = zeroForOnes[0] ? path[0].currency0 : path[0].currency1
	if (same(firstInput, NATIVE)) {
		if (!same(inputToken, weth)) throw new Error("UniswapFuelSwap: native route requires WETH input")
	} else if (!same(firstInput, inputToken)) {
		throw new Error("UniswapFuelSwap: first hop input mismatch")
	}

	const last = path.length - 1
	const lastOutput = zeroForOnes[last] ? path[last].currency1 : path[last].currency0
	if (!same(lastOutput, feeJuice)) throw new Error("UniswapFuelSwap: last hop must output feeJuice")

	for (let i = 0; i < path.length; i++) {
		if (!same(path[i].hooks, NATIVE)) throw new Error("UniswapFuelSwap: hooks not allowed")
		if (i < last) assertContinuity(route, i, weth)
	}
}

function assertContinuity(route: FuelRoute, i: number, weth: Address): void {
	const { path, zeroForOnes } = route
	const out = zeroForOnes[i] ? path[i].currency1 : path[i].currency0
	const next = zeroForOnes[i + 1] ? path[i + 1].currency0 : path[i + 1].currency1
	// The unwrap is directional and terminal: settlement takes WETH, unwraps, settles native — and
	// only the last hop's proceeds leave the contract. Native→WETH would owe WETH nobody wraps.
	const unwrap = same(out, weth) && same(next, NATIVE)
	if (same(out, next) || (unwrap && i + 1 === path.length - 1)) return
	throw new Error("UniswapFuelSwap: hop discontinuity")
}

function ethFjPool(o: DiscoverRouteOptions): PoolKey {
	return { currency0: NATIVE, currency1: o.feeJuice, fee: o.ethFj.fee, tickSpacing: o.ethFj.tickSpacing, hooks: NATIVE }
}

function candidateRoutes(o: DiscoverRouteOptions): FuelRoute[] {
	// A WETH deposit skips the token→WETH hop: the swap contract accepts a native first hop exactly
	// when the input token is WETH, so the tier list is irrelevant here.
	if (same(o.token, o.weth)) return [{ path: [ethFjPool(o)], zeroForOnes: [true] }]
	return o.tiers.map((tokenWeth) => buildFuelRoute({ token: o.token, weth: o.weth, feeJuice: o.feeJuice, tokenWeth, ethFj: o.ethFj }))
}

function bestOf(candidates: FuelRoute[], quotes: BatchedQuote[]): { route: FuelRoute; quoteOut: bigint } | undefined {
	let best: { route: FuelRoute; quoteOut: bigint } | undefined
	for (let i = 0; i < candidates.length; i++) {
		const q = quotes[i]
		if (q === undefined || !("out" in q) || q.out <= 0n) continue
		if (best === undefined || q.out > best.quoteOut) best = { route: candidates[i], quoteOut: q.out }
	}
	return best
}

export async function discoverFuelRoute(o: DiscoverRouteOptions): Promise<RouteOutcome> {
	if (same(o.token, o.feeAsset)) return { kind: "identity" }
	if (o.probeAmount <= 0n) return { kind: "unavailable", reason: "config" }

	const candidates = candidateRoutes(o)
	if (candidates.length === 0) return { kind: "unavailable", reason: "config" }
	for (const route of candidates) assertRouteGrammar(route, o.token, o.weth, o.feeJuice)

	let quotes: BatchedQuote[]
	try {
		quotes = await quoteFuelPathsBatched(o.client, o.quoter, o.multicall3, candidates, o.probeAmount)
	} catch {
		return { kind: "unavailable", reason: "rpc" }
	}

	const best = bestOf(candidates, quotes)
	return best === undefined ? { kind: "no-route", tried: candidates.length } : { kind: "route", ...best }
}
