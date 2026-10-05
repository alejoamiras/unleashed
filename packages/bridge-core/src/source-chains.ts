/**
 * The source chains a LI.FI-routed deposit may start on, as plain data the app, the decoder and the scripts share.
 * Viem-free on purpose: the app maps these ids to its own chain objects in one file. A manifest only enables
 * sources; a chain this catalogue does not know is refused rather than offered with guessed metadata.
 */
import type { ManifestV2 } from "./manifest-v2"

export interface SourceChain {
	chainId: number
	name: string
	nativeSymbol: string
	/** The Ethereum chain this source delivers into; a manifest for any other L1 may not enable it. */
	l1ChainId: number
	/**
	 * Keyless read RPCs, preferred first, each serving `eth_getLogs` without silently truncating it. Empty where none is
	 * chosen yet: the caller must supply one.
	 */
	rpcUrls: readonly string[]
}

const SEPOLIA = 11_155_111
const ETHEREUM = 1

export const SOURCE_CHAINS: Readonly<Record<number, SourceChain>> = {
	84532: {
		chainId: 84532,
		name: "Base Sepolia",
		nativeSymbol: "ETH",
		l1ChainId: SEPOLIA,
		// PublicNode refuses an over-large log query outright; the official endpoint caps a query at 500 blocks.
		rpcUrls: ["https://base-sepolia-rpc.publicnode.com", "https://sepolia.base.org"],
	},
	8453: { chainId: 8453, name: "Base", nativeSymbol: "ETH", l1ChainId: ETHEREUM, rpcUrls: [] },
	42161: { chainId: 42161, name: "Arbitrum One", nativeSymbol: "ETH", l1ChainId: ETHEREUM, rpcUrls: [] },
	10: { chainId: 10, name: "OP Mainnet", nativeSymbol: "ETH", l1ChainId: ETHEREUM, rpcUrls: [] },
}

type RoutingSource = NonNullable<NonNullable<ManifestV2["bridge"]>["routing"]>["sources"][number]

/** A source the manifest enables, joined with its catalogue entry. */
export interface EnabledSource extends SourceChain {
	rail: RoutingSource["rail"]
	tokens: RoutingSource["tokens"]
}

export function sourceChain(chainId: number): SourceChain | undefined {
	return SOURCE_CHAINS[chainId]
}

/**
 * The sources `m` enables, in manifest order; empty when it routes nothing. Throws when a source is missing from
 * `SOURCE_CHAINS` or delivers into another L1 than `m.l1ChainId`: either means the manifest and this build disagree.
 */
export function enabledSources(m: {
	l1ChainId: number
	bridge: { routing?: { sources: readonly RoutingSource[] } | null } | null
}): EnabledSource[] {
	return (m.bridge?.routing?.sources ?? []).map((src) => {
		const chain = sourceChain(src.chainId)
		if (chain === undefined) throw new Error(`source-chains: chain ${src.chainId} is not a known source`)
		if (chain.l1ChainId !== m.l1ChainId) {
			throw new Error(`source-chains: ${chain.name} delivers into chain ${chain.l1ChainId}, not ${m.l1ChainId}`)
		}
		return { ...chain, rail: src.rail, tokens: src.tokens }
	})
}
