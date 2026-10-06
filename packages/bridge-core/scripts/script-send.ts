/**
 * The manifest→send bindings the operator scripts share: which token a run targets, the generation
 * record every router call is built from, the fuel leg's quote + signed floor, and the token block
 * a hub claim consumes.
 */
import type { Address, Hex } from "viem"
import { type FuelQuoteReads, manifestFuelProvider } from "../src/fuel-quote"
import type { JournalTokenBlock } from "../src/journal"
import type { BridgeBlock, ManifestToken, ManifestV2 } from "../src/manifest-v2"
export { sendGenerationOf } from "../src/send-generation"

/** `--token <erc20>`, or the manifest's first token when the flag is absent. */
export function selectToken(bridge: BridgeBlock, argv: readonly string[]): ManifestToken {
	const flag = argv.indexOf("--token")
	const wanted = flag === -1 ? undefined : argv[flag + 1]
	const chosen = wanted === undefined ? bridge.tokens[0] : bridge.tokens.find((t) => t.erc20.toLowerCase() === wanted.toLowerCase())
	if (chosen) return chosen
	throw new Error(
		wanted === undefined
			? "the manifest carries no tokens — create a token's portal before running this"
			: `--token ${wanted} is not in the manifest — its portal has never been created`,
	)
}

/** The fuel budgets, or a refusal — a fueled run has nothing to size or floor its slice with without them. */
export function requireFuel(bridge: BridgeBlock): NonNullable<BridgeBlock["l1"]["fuel"]> {
	if (!bridge.l1.depositRouter || !bridge.l1.fuel) {
		throw new Error("the manifest carries no bridge.l1.depositRouter with its fuel budgets — a fueled send has nothing to quote")
	}
	return bridge.l1.fuel
}

export interface FuelLegPlan {
	/** The router's swap call for exactly the slice, its `_minAmountOut` set to `minFuelOutput`. */
	swapData: Hex
	/** What the provider says the slice buys right now — display + floor input, never the claim amount. */
	quote: bigint
	minFuelOutput: bigint
}

/**
 * The gas slice's quote at the slice itself, so the returned quote IS this send's expectation. The
 * fee asset is refused rather than quoted: its gas leg needs no swap, which belongs to the direct
 * fee-juice lane.
 */
export async function planFuelLeg(pub: FuelQuoteReads, m: ManifestV2, erc20: Address, fuelAmount: bigint): Promise<FuelLegPlan> {
	if (erc20.toLowerCase() === m.feeJuice.asset.toLowerCase()) {
		throw new Error(`${erc20} IS the fee asset — its gas leg needs no swap; use the direct fee-juice lane`)
	}
	const provider = manifestFuelProvider(m, pub)
	if (!provider) throw new Error("the manifest names no fuel swapper this script can quote — STOP")
	const r = await provider.quote(erc20, fuelAmount)
	if (!r.ok) throw new Error(`no fuel quote for ${erc20} (${r.reason}) — give the swapper a rate or pick another token; STOP`)
	return { swapData: r.quote.swapData, quote: r.quote.expectedOut, minFuelOutput: r.quote.minOut }
}

/** The read-back block a claim consumes; its derived L2 token must be the manifest's. */
export function claimTokenBlock(token: ManifestToken, readBack: JournalTokenBlock): JournalTokenBlock {
	if (readBack.l2Token.toLowerCase() !== token.l2Token.toLowerCase())
		throw new Error(`the factory's registration derives L2 token ${readBack.l2Token}, the manifest says ${token.l2Token} — STOP`)
	return readBack
}
