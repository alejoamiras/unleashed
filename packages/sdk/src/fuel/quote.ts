import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import type { Address } from "viem"
import { refusal } from "../errors.ts"
import { type FuelVenue, isFeeAsset, quoteRefusal, quoteSlice, venueOf } from "../execution/fuel-venue.ts"
import { assertNetwork, type Network, type Privacy, type Reads } from "../network.ts"

export interface FuelRate {
	probeIn: bigint
	probeOut: bigint
	/** LI.FI's venue for the probe; display only. */
	tool?: string
}

/** A reviewed gas-only deposit: `depositFuel` signs exactly this, or refuses. */
export interface FuelQuote {
	readonly network: Network
	readonly token: Address
	readonly amount: bigint
	readonly recipient: string
	readonly privacy: Privacy
	readonly venue: FuelVenue
	readonly tool?: string
	/** What the venue expects `amount` to buy, in Fee Juice base units; display only. */
	readonly expectedFj: bigint
	/** The floor the deposit signs: the router reverts below it, so this is the least the claim receives. */
	readonly minFj: bigint
}

/**
 * A rate for sizing, with no floor: what `probeIn` of `token` buys. A probe below a venue's minimum says nothing about
 * a larger amount, so it never stands in for `quoteFuel`.
 */
export async function probeFuel(net: Network, r: Reads, token: Address, probeIn: bigint): Promise<FuelRate> {
	assertNetwork(net)
	if (probeIn <= 0n) throw refusal("invalid-request", "probeIn must be positive")
	if (isFeeAsset(net, token)) return { probeIn, probeOut: probeIn }
	const res = await venueOf(net, r).probe(token, probeIn)
	if (!res.ok) throw quoteRefusal(res)
	return { probeIn, probeOut: res.probe.probeOut, ...(res.probe.tool ? { tool: res.probe.tool } : {}) }
}

/** An Aztec address is a Grumpkin x-coordinate; a word that is not one can never be decrypted to. */
export async function assertRecipient(recipient: string): Promise<void> {
	let valid = false
	try {
		valid =
			/^0x[0-9a-fA-F]{64}$/.test(recipient) && !/^0x0+$/.test(recipient) && (await AztecAddress.fromStringUnsafe(recipient).isValid())
	} catch {
		valid = false
	}
	if (!valid) throw refusal("invalid-request", `${recipient} is not an Aztec address`)
}

/** The executable quote for a gas-only deposit of `amount` of `token`, with the floor it will sign. */
export async function quoteFuel(
	net: Network,
	r: Reads,
	q: { token: Address; amount: bigint; recipient: string; privacy: Privacy },
): Promise<FuelQuote> {
	assertNetwork(net)
	if (q.amount <= 0n) throw refusal("invalid-request", "amount must be positive")
	await assertRecipient(q.recipient)
	const s = await quoteSlice(net, r, q.token, q.amount)
	return Object.freeze({
		network: net,
		token: q.token,
		amount: q.amount,
		recipient: q.recipient,
		privacy: q.privacy,
		venue: s.venue,
		...(s.tool ? { tool: s.tool } : {}),
		expectedFj: s.expectedOut,
		minFj: s.minOut,
	})
}
