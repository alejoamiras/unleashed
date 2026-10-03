import { describe, expect, it } from "vitest"
import { l1ToL2MessageReadiness, type MessageReadinessNode } from "./l1-to-l2-readiness"

const HASH = "0x0000000000000000000000000000000000000000000000000000000000000abc"

const node = (index: bigint | undefined, treeSize: number): MessageReadinessNode => ({
	getL1ToL2MessageIndex: async () => index,
	getBlockData: async () => ({ header: { state: { l1ToL2MessageTree: { nextAvailableLeafIndex: treeSize } } } }),
})

describe("l1ToL2MessageReadiness", () => {
	it("is null until the node has ingested the message", async () => {
		expect(await l1ToL2MessageReadiness(node(undefined, 4096), HASH)).toBeNull()
	})

	it("counts the subtrees still missing, and is ready exactly once the tree passes the index", async () => {
		// Index 5000 sits in the 5th 1024-leaf subtree; 3 are in.
		expect(await l1ToL2MessageReadiness(node(5000n, 3072), HASH)).toEqual({ checkpoint: 5, anchor: 3 })
		expect(await l1ToL2MessageReadiness(node(5000n, 4096), HASH)).toEqual({ checkpoint: 5, anchor: 4 })
		const ready = await l1ToL2MessageReadiness(node(5000n, 5120), HASH)
		expect(ready && ready.anchor >= ready.checkpoint).toBe(true)
		// Boundary: the last leaf of a subtree is consumable once that subtree lands, not before.
		expect(await l1ToL2MessageReadiness(node(1023n, 1023), HASH)).toEqual({ checkpoint: 1, anchor: 0 })
		const edge = await l1ToL2MessageReadiness(node(1023n, 1024), HASH)
		expect(edge && edge.anchor >= edge.checkpoint).toBe(true)
	})
})
