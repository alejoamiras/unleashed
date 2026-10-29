/**
 * Wallet-independent reads, one client per chain over the build's pinned keyless RPCs (in order, the next when one
 * fails). Watching a cross-chain deposit must not depend on which chain the wallet is on, or on a wallet at all; a
 * chain the build pins no RPC for has no reader, and whatever needs one reports that instead of borrowing the
 * wallet's transport.
 */
import type { DiscoveryChainReads, DiscoveryReads } from "@unleashed/bridge-core"
import { type Erc20Client, readErc20Balances } from "@unleashed/sdk/protocol"
import { type Address, BaseError, CallExecutionError, createPublicClient, fallback, http, type PublicClient } from "viem"
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

/**
 * ERC-20 balances through `pub` in one `eth_call`: viem would split past 28 tokens, so callers bound the list. A call
 * that fails rejects: viem's `allowFailure` reports it as every token failing, which `readErc20Balances` reads as zero.
 */
export function readBalancesOn(pub: PublicClient, owner: Address, tokens: readonly Address[]): Promise<Map<Address, bigint>> {
	const client: Erc20Client = {
		multicall: async (args) => {
			const results = await pub.multicall({ ...args, batchSize: 0 })
			const lost = results.find((r) => r.error instanceof BaseError && r.error.walk((e) => e instanceof CallExecutionError))
			if (lost) throw lost.error
			return results
		},
		call: (args) => pub.call(args),
	}
	return readErc20Balances(client, owner, tokens)
}

/** Test-only: forget every built client. */
export function __resetReadClientsForTests(): void {
	clients.clear()
}
