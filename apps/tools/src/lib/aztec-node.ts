/** The app's one Aztec node client: the SDK keys per-network caches by node, so every caller shares this instance. */
import { createAztecNodeClient } from "@aztec-labs/aztec.js/node"
import { NETWORK } from "@/lib/network"

let node: ReturnType<typeof createAztecNodeClient> | undefined

export function appNode(): ReturnType<typeof createAztecNodeClient> {
	node ??= createAztecNodeClient(NETWORK.nodeUrl)
	return node
}
