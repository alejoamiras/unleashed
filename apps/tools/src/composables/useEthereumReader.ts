/**
 * Wallet-independent reads, one client per chain over the build's pinned keyless RPCs (in order, the next when one
 * fails). Watching a cross-chain deposit must not depend on which chain the wallet is on, or on a wallet at all; a
 * chain the build pins no RPC for has no reader, and whatever needs one reports that instead of borrowing the
 * wallet's transport.
 */
import type { DiscoveryChainReads, DiscoveryReads } from "@unleashed/bridge-core"
import { createPublicClient, fallback, http, type PublicClient } from "viem"
import { NETWORK, readChainOf } from "@/lib/network"

/** One read must never hold a watcher forever; discovery's own budget bounds the whole scan. */
const READ_TIMEOUT_MS = 20_000

const clients = new Map<number, PublicClient>()

/** The read client for `chainId`, built once; undefined where this build pins no RPC for it. */
export function readClientFor(chainId: number): PublicClient | undefined {
	const cached = clients.get(chainId)
	if (cached) return cached
	const read = readChainOf(chainId)
	if (!read || read.rpcUrls.length === 0) return undefined
	const client = createPublicClient({
		chain: read.chain,
		transport: fallback(read.rpcUrls.map((url) => http(url, { timeout: READ_TIMEOUT_MS, retryCount: 1 }))),
	}) as PublicClient
	clients.set(chainId, client)
	return client
}

/** Discovery's reads for a deposit from `srcChainId`; undefined unless both chains have a reader. */
export function discoveryReadsFor(srcChainId: number): DiscoveryReads | undefined {
	const source = readClientFor(srcChainId)
	const ethereum = readClientFor(NETWORK.l1ChainId)
	if (!source || !ethereum) return undefined
	return { source: source as unknown as DiscoveryChainReads, ethereum: ethereum as unknown as DiscoveryChainReads }
}

export function useEthereumReader() {
	return { ethereum: () => readClientFor(NETWORK.l1ChainId), forChain: readClientFor, discoveryReadsFor }
}

/** Test-only: forget every built client. */
export function __resetReadClientsForTests(): void {
	clients.clear()
}
