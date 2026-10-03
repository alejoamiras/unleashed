import { L1_TO_L2_MSG_SUBTREE_HEIGHT } from "@aztec-labs/constants"
import { Fr } from "@aztec-labs/foundation/curves/bn254"

/** The node reads readiness needs; structural so tests and both node clients satisfy it. */
export type MessageReadinessNode = {
	getL1ToL2MessageIndex(message: Fr): Promise<bigint | undefined>
	getBlockData(
		block: "latest",
	): Promise<{ header: { state: { l1ToL2MessageTree: { nextAvailableLeafIndex: number | bigint } } } } | undefined>
}

/** Each checkpoint appends one subtree of this many leaves to the L1→L2 message tree. */
const LEAVES_PER_CHECKPOINT = 2n ** BigInt(L1_TO_L2_MSG_SUBTREE_HEIGHT)

/**
 * How far an L1→L2 message is from being consumable, counted in checkpoint subtrees: the message
 * needs `checkpoint` subtrees in the latest block's tree and `anchor` are there, so it is claimable
 * exactly when `anchor >= checkpoint`. `null` until the node has ingested the message from L1.
 */
export async function l1ToL2MessageReadiness(
	node: MessageReadinessNode,
	messageHash: string,
): Promise<{ checkpoint: number; anchor: number } | null> {
	const index = await node.getL1ToL2MessageIndex(Fr.fromString(messageHash))
	if (index === undefined) return null
	const treeSize = BigInt((await node.getBlockData("latest"))?.header.state.l1ToL2MessageTree.nextAvailableLeafIndex ?? 0)
	// Ready is `treeSize > index`; the subtree counts keep that equivalence for any tree size.
	if (treeSize > index) return { checkpoint: 0, anchor: 0 }
	return { checkpoint: Number(index / LEAVES_PER_CHECKPOINT) + 1, anchor: Number(treeSize / LEAVES_PER_CHECKPOINT) }
}
