/**
 * How a chain is named and linked on screen: Ethereum (the bridge's L1) or a chain a deposit starts on.
 * Chain identity itself comes from `@/lib/network`; this file only words it.
 */
import { L1_CHAIN_LABEL, NETWORK, readChainOf } from "@/lib/network"

/** The names the screens use where the catalogue's own is longer ("Arbitrum One", "OP Mainnet"). */
const SHORT_NAMES: ReadonlyMap<number, string> = new Map([
	[8453, "Base"],
	[84532, "Base Sepolia"],
	[42161, "Arbitrum"],
	[10, "Optimism"],
])

const BADGES: ReadonlyMap<number, string> = new Map([
	[8453, "BASE"],
	[84532, "BASE"],
	[42161, "ARB"],
	[10, "OP"],
])

export function isEthereum(chainId: number): boolean {
	return chainId === NETWORK.l1ChainId
}

/** "Ethereum" (or "Ethereum · Sepolia" off mainnet) for the L1, the chain's short name otherwise. */
export function chainLabel(chainId: number): string {
	if (isEthereum(chainId)) return L1_CHAIN_LABEL
	return SHORT_NAMES.get(chainId) ?? readChainOf(chainId)?.chain.name ?? `Chain ${chainId}`
}

/** The chip a row or a route step carries: "ETH", "BASE", "ARB", "OP". */
export function chainBadge(chainId: number): string {
	if (isEthereum(chainId)) return "ETH"
	const known = BADGES.get(chainId)
	if (known) return known
	const word = chainLabel(chainId).split(/\s+/)[0] ?? ""
	return word.slice(0, 4).toUpperCase() || "?"
}

export type Rail = "acrossV4" | "stargateV2"

const RAIL_NAMES: Record<Rail, string> = { acrossV4: "Across", stargateV2: "Stargate" }

export function railLabel(rail: Rail): string {
	return RAIL_NAMES[rail]
}

/** Journal fields are user-writable storage: only a strict hash or address reaches a URL. */
const TX_HASH = /^0x[0-9a-f]{64}$/i
const ADDRESS = /^0x[0-9a-f]{40}$/i

function explorerBase(chainId: number): string {
	if (isEthereum(chainId)) return NETWORK.l1ExplorerBaseUrl
	const url = readChainOf(chainId)?.chain.blockExplorers?.default.url ?? ""
	return url.endsWith("/") ? url.slice(0, -1) : url
}

/** The chain's block-explorer page for `hash`; "" where the chain has no explorer or the hash is malformed. */
export function chainTxUrl(chainId: number, hash: string): string {
	const base = explorerBase(chainId)
	return base && TX_HASH.test(hash) ? `${base}/tx/${hash}` : ""
}

export function chainAddressUrl(chainId: number, address: string): string {
	const base = explorerBase(chainId)
	return base && ADDRESS.test(address) ? `${base}/address/${address}` : ""
}

export function chainTokenUrl(chainId: number, address: string): string {
	const base = explorerBase(chainId)
	return base && ADDRESS.test(address) ? `${base}/token/${address}` : ""
}

/** LI.FI's explorer for a transfer, keyed by its source transaction. */
export function lifiScanUrl(srcTxHash: string): string {
	return TX_HASH.test(srcTxHash) ? `https://scan.li.fi/tx/${srcTxHash}` : ""
}
