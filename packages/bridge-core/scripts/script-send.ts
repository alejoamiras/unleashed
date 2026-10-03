/**
 * The manifest→send bindings the operator scripts share: which token a run targets, the generation
 * record every router call is built from, the fuel leg's route + signed floor, and the token block
 * a hub claim consumes.
 */
import type { Address, PublicClient } from "viem"
import { signedMinFuelOutput } from "../src/gas-share"
import type { JournalTokenBlock } from "../src/journal"
import type { PoolKey } from "../src/l1"
import type { BridgeBlock, ManifestToken } from "../src/manifest-v2"
import { discoverFuelRoute } from "../src/route-discovery"
export { sendGenerationOf } from "../src/send-generation"

export type SwapBlock = NonNullable<BridgeBlock["l1"]["swap"]>

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

/** The swap block, or a refusal — a fueled run has no route to quote without one. */
export function requireSwap(bridge: BridgeBlock): SwapBlock {
	if (!bridge.l1.swap) throw new Error("the manifest carries no bridge.l1.swap — a fueled send has nothing to quote")
	return bridge.l1.swap
}

export interface FuelLegPlan {
	path: PoolKey[]
	zeroForOnes: boolean[]
	/** What the probe says `fuelAmount` buys right now — display + floor input, never the claim amount. */
	quote: bigint
	minFuelOutput: bigint
}

/**
 * The gas slice's route, probed at the slice itself so the returned quote IS this send's expectation.
 * The fee asset is refused rather than silently routed: its gas leg is an identity swap, which
 * belongs to the direct fee-juice lane.
 */
export async function planFuelLeg(
	pub: PublicClient,
	swap: SwapBlock,
	feeAsset: Address,
	erc20: Address,
	fuelAmount: bigint,
): Promise<FuelLegPlan> {
	const outcome = await discoverFuelRoute({
		client: pub,
		quoter: swap.quoter as Address,
		multicall3: swap.multicall3 as Address,
		token: erc20,
		feeAsset,
		weth: swap.weth as Address,
		feeJuice: swap.feeJuice as Address,
		tiers: swap.tiers,
		ethFj: swap.ethFj,
		probeAmount: fuelAmount,
	})
	if (outcome.kind === "identity") throw new Error(`${erc20} IS the fee asset — its gas leg needs no swap; use the direct fee-juice lane`)
	if (outcome.kind !== "route") throw new Error(`no fuel route for ${erc20} (${outcome.kind}) — seed a pool or pick another token; STOP`)
	return {
		path: outcome.route.path,
		zeroForOnes: outcome.route.zeroForOnes,
		quote: outcome.quoteOut,
		minFuelOutput: signedMinFuelOutput(outcome.quoteOut, swap.slippageBps, BigInt(swap.minFuelFj)),
	}
}

/** The read-back block a claim consumes; its derived L2 token must be the manifest's. */
export function claimTokenBlock(token: ManifestToken, readBack: JournalTokenBlock): JournalTokenBlock {
	if (readBack.l2Token.toLowerCase() !== token.l2Token.toLowerCase())
		throw new Error(`the factory's registration derives L2 token ${readBack.l2Token}, the manifest says ${token.l2Token} — STOP`)
	return readBack
}
