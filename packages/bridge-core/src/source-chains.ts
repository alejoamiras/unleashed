/**
 * The source chains a LI.FI-routed deposit may start on, as plain data the app, the decoder and the scripts share.
 * Viem-free on purpose: the app maps these ids to its own chain objects in one file. A manifest only enables
 * sources; a chain this catalogue does not know is refused rather than offered with guessed metadata.
 */
import type { ManifestV2 } from "@unleashed/sdk/protocol"

export interface SourceChain {
	chainId: number
	name: string
	nativeSymbol: string
	/** The Ethereum chain this source delivers into; a manifest for any other L1 may not enable it. */
	l1ChainId: number
	/**
	 * Keyless read RPCs, preferred first, each refusing an `eth_getLogs` range past its cap rather than truncating it.
	 * Empty where none is chosen yet: the caller must supply one.
	 */
	rpcUrls: readonly string[]
	/**
	 * Per URL of `rpcUrls`, the most blocks (inclusive) one `eth_getLogs` request may span, set at or below the measured
	 * limit. A reader splits a wider range into requests within it (`cappedLogs`).
	 */
	maxLogBlocks?: Readonly<Record<string, number>>
	/**
	 * Per URL of `rpcUrls`, how many of the latest blocks the endpoint answers `eth_getLogs` completely for, set at or
	 * below the measured retention. Older, it may answer short or empty without an error, so a reader refuses such a
	 * range before sending it and asks the next URL (`keptLogs`). Absent: the endpoint keeps all logs, or refuses the
	 * ones it does not.
	 */
	logRetentionBlocks?: Readonly<Record<string, number>>
}

const SEPOLIA = 11_155_111
const ETHEREUM = 1

export const SOURCE_CHAINS: Readonly<Record<number, SourceChain>> = {
	84532: {
		chainId: 84532,
		name: "Base Sepolia",
		nativeSymbol: "ETH",
		l1ChainId: SEPOLIA,
		rpcUrls: ["https://base-sepolia-rpc.publicnode.com", "https://sepolia.base.org"],
		// As measured: PublicNode refuses `to − from > 50,000` (-32701) and answers of over 20,000 logs (-32602); the
		// official endpoint refuses `to − from > 200` (-32614).
		maxLogBlocks: { "https://base-sepolia-rpc.publicnode.com": 50_000, "https://sepolia.base.org": 200 },
		// As measured at head ≈ 51,950,000: PublicNode keeps logs complete from block 47,000,000, answers `[]` for the
		// half-million blocks before it and refuses older ones (4444); it answers receipts below 47,000,000 `null`. The
		// boundaries did not move with the head, so they may advance in steps: 3,000,000 keeps a wide margin. The
		// official endpoint serves logs and receipts far older; both refuse blocks below 46,500,000.
		logRetentionBlocks: { "https://base-sepolia-rpc.publicnode.com": 3_000_000 },
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
 * `catalogue` or delivers into another L1 than `m.l1ChainId`: either means the manifest and this build disagree.
 * Only a local build passes a catalogue beyond `SOURCE_CHAINS`, to add its own sandbox chain.
 */
export function enabledSources(
	m: {
		l1ChainId: number
		bridge: { routing?: { sources: readonly RoutingSource[] } | null } | null
	},
	catalogue: Readonly<Record<number, SourceChain>> = SOURCE_CHAINS,
): EnabledSource[] {
	return (m.bridge?.routing?.sources ?? []).map((src) => {
		const chain = catalogue[src.chainId]
		if (chain === undefined) throw new Error(`source-chains: chain ${src.chainId} is not a known source`)
		if (chain.l1ChainId !== m.l1ChainId) {
			throw new Error(`source-chains: ${chain.name} delivers into chain ${chain.l1ChainId}, not ${m.l1ChainId}`)
		}
		return { ...chain, rail: src.rail, tokens: src.tokens }
	})
}
