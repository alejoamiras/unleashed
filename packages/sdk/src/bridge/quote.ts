import type { Address } from "viem"
import { refusal } from "../errors.ts"
import { type MaxFees, maxFeesOf, privateHubCeilings } from "../execution/fee-ceilings.ts"
import { type FuelVenue, isFeeAsset, quoteSlice } from "../execution/fuel-venue.ts"
import { assertRecipient, probeFuel } from "../fuel/quote.ts"
import { assertNetwork, type Network, type Privacy, type Reads } from "../network.ts"
import { proposeGasShare } from "../protocol/gas-share.ts"
import type { BridgeToken } from "./token.ts"

/** The gas a token deposit buys on the way in. */
export interface BridgeGasLeg {
	/** The slice of the deposit swapped into Fee Juice, in token base units. */
	readonly fuelAmount: bigint
	/** The Fee Juice the slice was sized to buy. */
	readonly targetFj: bigint
	readonly expectedFj: bigint
	/** The floor the deposit signs. */
	readonly minFj: bigint
	readonly venue: FuelVenue
	readonly tool?: string
	/** The slice hit its cap and buys less than `targetFj`. */
	readonly capped: "min" | "half" | "max" | null
}

/** A reviewed token deposit: `depositToken` signs exactly this, or refuses. */
export interface BridgeQuote {
	readonly network: Network
	readonly token: BridgeToken
	/** The total pulled from the account: the token leg plus the gas slice. */
	readonly amount: bigint
	/** What the token leg delivers. */
	readonly tokenAmount: bigint
	readonly recipient: string
	readonly privacy: Privacy
	readonly gas?: BridgeGasLeg
}

const ERC20_ADDRESS = /^0x[0-9a-fA-F]{40}$/

/** Sizes the slice for `txTarget` transactions and quotes it. A private claim's fee ceilings are sized in. */
async function gasLeg(
	net: Network,
	r: Reads,
	q: { token: BridgeToken; amount: bigint; privacy: Privacy; gas: { txTarget: number; maxFees?: MaxFees } },
): Promise<BridgeGasLeg> {
	const fuel = net.manifest.bridge?.l1.fuel
	if (!fuel) throw refusal("no-fuel-route", `${net.name} sells no gas with a token`)
	const identity = isFeeAsset(net, q.token.erc20 as Address)
	const registers = q.token.state !== "registered"
	const ceilings = q.privacy === "private" ? await privateHubCeilings(r, registers, await maxFeesOf(r, q.gas.maxFees)) : undefined
	const rate = await probeFuel(net, r, q.token.erc20, q.amount)
	const share = proposeGasShare({
		amount: q.amount,
		decimals: q.token.decimals,
		txTarget: q.gas.txTarget,
		fjPerTx: BigInt(fuel.fjPerTx),
		...(ceilings === undefined ? (registers ? { fjRegister: BigInt(fuel.fjRegister) } : {}) : { fjCeilings: ceilings }),
		minFuelFj: BigInt(fuel.minFuelFj),
		rate,
		slippageBps: identity ? 0 : fuel.slippageBps,
		...(identity ? { maxFuelAmount: q.amount - 1n } : {}),
	})
	if (share.fuelAmount <= 0n || share.fuelAmount >= q.amount)
		throw refusal("below-floor", "the amount is too small to buy gas and still send a token")
	const s = await quoteSlice(net, r, q.token.erc20, share.fuelAmount)
	if (ceilings !== undefined && s.minOut <= ceilings) {
		throw refusal("below-floor", `the gas slice's floor ${s.minOut} does not cover the ${ceilings} a private claim sets aside`)
	}
	return {
		fuelAmount: share.fuelAmount,
		targetFj: share.fuelFj,
		expectedFj: s.expectedOut,
		minFj: s.minOut,
		venue: s.venue,
		...(s.tool ? { tool: s.tool } : {}),
		capped: share.capped,
	}
}

/**
 * The executable quote for a token deposit, with or without gas. `gas.txTarget` sizes the slice for that many
 * ordinary transactions; `gas.maxFees` prices a private claim's ceilings the way the caller's wallet will submit it
 * (the Aztec node's worst prediction when absent, which a wallet that pads its fees can exceed).
 */
export async function quoteBridge(
	net: Network,
	r: Reads,
	q: { token: BridgeToken; amount: bigint; recipient: string; privacy: Privacy; gas?: { txTarget: number; maxFees?: MaxFees } },
): Promise<BridgeQuote> {
	assertNetwork(net)
	if (q.token.network !== net) throw refusal("invalid-request", "the token was resolved on another network")
	if (!ERC20_ADDRESS.test(q.token.erc20)) throw refusal("invalid-request", `${q.token.erc20} is not an address`)
	if (q.amount <= 0n) throw refusal("invalid-request", "amount must be positive")
	await assertRecipient(q.recipient)
	const gas = q.gas ? await gasLeg(net, r, { ...q, gas: q.gas }) : undefined
	return Object.freeze({
		network: net,
		token: q.token,
		amount: q.amount,
		tokenAmount: q.amount - (gas?.fuelAmount ?? 0n),
		recipient: q.recipient,
		privacy: q.privacy,
		...(gas ? { gas } : {}),
	})
}
