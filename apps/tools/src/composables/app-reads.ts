/**
 * The reads the app's claims run with, and the fee bound the app's own private-fee quotes (the gas slice, the private
 * exit) are checked against over the same reads: the build's pinned Ethereum reader where it has one (a cross-chain
 * send leaves the wallet on its source chain), the Ethereum wallet's otherwise, and the app's Aztec node.
 */
import type { Reads } from "@unleashed/sdk"
import { feeBoundOf, type MaxFees } from "@unleashed/sdk/internal"
import type { PublicClient } from "viem"
import { bridgeNetwork } from "@/contracts/bridge-generation"
import { appNode } from "@/lib/aztec-node"
import { NETWORK } from "@/lib/network"
import { readClientFor } from "./useEthereumReader"
import { useL1Wallet } from "./useL1Wallet"

export function appReads(l1: { publicClient: unknown }): Reads {
	return { l1: (readClientFor(NETWORK.l1ChainId) ?? l1.publicClient) as PublicClient, aztecNode: appNode() }
}

/** The SDK's fee bound on the checked network, read afresh on every call. */
export function appFeeBound(l1: { publicClient: unknown } = useL1Wallet()): () => Promise<MaxFees> {
	const reads = appReads(l1)
	return async () => feeBoundOf(await bridgeNetwork(reads), reads)
}
