/**
 * The hub's binding for an ERC-20, read from the node's public storage. No Aztec wallet is involved:
 * a token registered on the hub reads as registered on a plain Ethereum wallet too, so the wizard
 * never shows a first-time path for a token that has none.
 */
import { createAztecNodeClient } from "@aztec-labs/aztec.js/node"
import { hubBindingAt } from "@unleashed/bridge-core"
import { HUB } from "@/contracts/bridge-generation"
import { NETWORK } from "@/lib/network"

type NodeClient = ReturnType<typeof createAztecNodeClient>

let node: NodeClient | undefined

/**
 * Fails closed, in the user's words: a node that cannot be reached must not let a registered token
 * pass for a first send (the very mistake this read exists to prevent), so the selection reports
 * the outage instead of guessing.
 */
export async function readHubBinding(erc20: string): Promise<string | undefined> {
	if (!HUB) return undefined
	node ??= createAztecNodeClient(NETWORK.nodeUrl)
	try {
		return await hubBindingAt(node, HUB.toString(), erc20)
	} catch (e) {
		console.debug(e instanceof Error ? e : new Error("hub binding read failed"))
		throw new Error("Couldn't reach the Aztec node to read this token's status. Try again in a moment.")
	}
}
