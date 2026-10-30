/**
 * Wallet-independent reads, one client per chain over the build's pinned keyless RPCs (in order, the next when one
 * fails). Watching a cross-chain deposit must not depend on which chain the wallet is on, or on a wallet at all; a
 * chain the build pins no RPC for has no reader, and whatever needs one reports that instead of borrowing the
 * wallet's transport.
 */
import { cappedLogs, type DiscoveryChainReads, type DiscoveryReads, keptLogs, receiptOrNext, sourceChain } from "@unleashed/bridge-core"
import { type Erc20Client, readErc20Balances } from "@unleashed/sdk/protocol"
import { type Address, createPublicClient, fallback, http, type PublicClient } from "viem"
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
	const source = sourceChain(chainId)
	const endpoint = (url: string, i: number) => {
		const cap = source?.maxLogBlocks?.[url]
		const kept = source?.logRetentionBlocks?.[url]
		let transport = http(url, { timeout: READ_TIMEOUT_MS, retryCount: 1 })
		if (cap !== undefined) transport = cappedLogs(transport, cap)
		if (kept !== undefined) transport = keptLogs(transport, kept)
		// The last endpoint's `null` receipt must stay viem's "not found", which receipt polling waits through.
		return i < read.rpcUrls.length - 1 ? receiptOrNext(transport) : transport
	}
	// `ccipRead: false`: a read stays on the pinned RPCs, never at a URL the called contract names (EIP-3668).
	const client = createPublicClient({
		chain: read.chain,
		transport: fallback(read.rpcUrls.map(endpoint)),
		ccipRead: false,
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

/** ERC-20 balances through `pub` in one `eth_call`: viem would split past 28 tokens, so callers bound the list. */
export function readBalancesOn(pub: PublicClient, owner: Address, tokens: readonly Address[]): Promise<Map<Address, bigint>> {
	const client: Erc20Client = {
		multicall: (args) => pub.multicall({ ...args, batchSize: 0 }),
		call: (args) => pub.call(args),
	}
	return readErc20Balances(client, owner, tokens)
}

/** Test-only: forget every built client. */
export function __resetReadClientsForTests(): void {
	clients.clear()
}
