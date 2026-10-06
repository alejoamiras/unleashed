import type { Address, Hex } from "viem"
import { describe, expect, it } from "vitest"
import { type Destination, fillGas, TX_GAS_CAP } from "./relayer"

const POOL: Address = `0x${"5b".repeat(20)}`
const log = (address: string, topic: string) => ({ address, topics: [`0x${topic.repeat(32)}`] })

/** A fill whose message completes from `threshold` gas up and is recovered by LI.FI's receiver below it, as on Sepolia. */
function destination(estimate: bigint, threshold: bigint) {
	const simulated: bigint[] = []
	const pub = {
		estimateGas: async () => estimate,
		simulateBlocks: async ({ blocks }: { blocks: { calls: { gas: bigint }[] }[] }) => {
			const { gas } = blocks[0].calls[0]
			simulated.push(gas)
			const marker = gas >= threshold ? log("0xe0", "c0") : log("0x5e", "ec")
			return [{ calls: [{ status: "success", logs: [log("0x5b", "f1"), marker] }] }]
		},
	}
	return { dest: { public: pub, wallet: { account: { address: `0x${"ca".repeat(20)}` } } } as unknown as Destination, simulated }
}

describe("fillGas", () => {
	it("sends with the smallest doubling of the estimate whose simulated logs match those at the cap", async () => {
		// Sepolia's node estimated 1,076,281 for a fill whose deposit needs 1,395,000; at 1.15× it was recovered.
		const { dest, simulated } = destination(600_000n, 1_395_000n)
		expect(await fillGas(dest, POOL, "0x" as Hex)).toBe(2_400_000n)
		expect(simulated).toEqual([TX_GAS_CAP, 1_200_000n, 2_400_000n])
	})

	it("falls back to the cap when no smaller doubling reaches the outcome the cap simulates", async () => {
		const { dest } = destination(1_000_000n, 16_000_001n)
		expect(await fillGas(dest, POOL, "0x" as Hex)).toBe(TX_GAS_CAP)
	})
})
