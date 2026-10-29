/**
 * Where a network's gas slice is swapped, and the quote a deposit signs: identity for the fee asset, the pinned
 * testnet swapper where the manifest lists one, otherwise LI.FI through the caller's `fetch` (or the global one).
 */
import type { Address, Hex } from "viem"
import { type BridgeError, refusal } from "../errors.ts"
import type { Network, Reads } from "../network.ts"
import { signedMinFuelOutput } from "../protocol/gas-share.ts"
import { type FuelQuoteProvider, type FuelQuoteRefusal, manifestFuelProvider, withFuelFloor } from "./fuel-quote.ts"

export type FuelVenue = "identity" | "lifi" | "testnetSwapper"

export interface SliceQuote {
	venue: FuelVenue
	/** LI.FI's venue; provider-supplied text. */
	tool?: string
	expectedOut: bigint
	/** The floor signed into the deposit: never below the network's claim minimum. */
	minOut: bigint
}

export const isFeeAsset = (net: Network, token: Address) => token.toLowerCase() === net.fuel.feeAsset.toLowerCase()

/** The swap venue; `fetch-unavailable` when it is LI.FI and no `fetch` exists, never a "no route". */
export function venueOf(net: Network, r: Reads): FuelQuoteProvider {
	const lifi = !net.fuel.fuelSwapper
	const fetcher = r.fetch ?? (typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : undefined)
	if (lifi && !fetcher)
		throw refusal("fetch-unavailable", "pricing gas on this network needs li.quest, and no fetch is available", "safe")
	const provider = manifestFuelProvider(net.manifest, r.l1 as never, fetcher ? { lifi: { fetch: fetcher } } : {})
	if (!provider) throw refusal("no-fuel-route", `${net.name} has no gas venue`)
	return provider
}

/** A venue's refusal as the caller's error: no quote is "no-fuel-route", a quote too small to floor is "below-floor". */
export function quoteRefusal(res: FuelQuoteRefusal): BridgeError {
	if (res.reason === "floor") {
		return refusal("below-floor", `this amount buys ${res.expectedOut} Fee Juice, under the ${res.floor} a claim needs`)
	}
	const why = res.reason === "unsafe" ? `the venue's quote broke a pin (${res.field})` : res.message
	return refusal("no-fuel-route", why, "after-wait")
}

function identityQuote(net: Network, amount: bigint): SliceQuote {
	const minOut = signedMinFuelOutput(amount, net.fuel.slippageBps, net.fuel.minFuelFj)
	if (minOut > amount) throw refusal("below-floor", `${amount} Fee Juice is under the ${net.fuel.minFuelFj} a claim needs`)
	return { venue: "identity", expectedOut: amount, minOut }
}

/** The quote for exactly `amount` of `token`, floored by the network's budgets. */
export async function quoteSlice(net: Network, r: Reads, token: Address, amount: bigint): Promise<SliceQuote> {
	if (isFeeAsset(net, token)) return identityQuote(net, amount)
	const res = await venueOf(net, r).quote(token, amount)
	if (!res.ok) throw quoteRefusal(res)
	const q = res.quote
	return { venue: q.provider, ...(q.provider === "lifi" ? { tool: q.tool } : {}), expectedOut: q.expectedOut, minOut: q.minOut }
}

/**
 * The swap bytes a deposit signs: a fresh quote at exactly the reviewed slice, carrying the reviewed floor. Refuses
 * with `quote-moved` when the venue now quotes under that floor, so a signature never binds a swap that would revert
 * or a floor the caller did not review. The fee asset needs no swap.
 */
export async function swapDataFor(net: Network, r: Reads, token: Address, amount: bigint, reviewedFloor: bigint): Promise<Hex> {
	if (isFeeAsset(net, token)) return "0x"
	const res = await venueOf(net, r).quote(token, amount)
	if (!res.ok || res.quote.expectedOut < reviewedFloor) {
		throw refusal("quote-moved", "the gas price moved under the reviewed floor; quote again", "safe")
	}
	return withFuelFloor(res.quote.swapData, reviewedFloor)
}
