import type { Address, Hex } from "viem"
import { describe, expect, it } from "vitest"
import { type Destination, fillGas, TX_GAS_CAP } from "./relayer"

const POOL: Address = `0x${"5b".repeat(20)}`
const BLOCK = 77n
const word = (b: string) => `0x${b.repeat(32)}`
const log = (address: string, topics: string[], data = "0x") => ({ address, topics: topics.map(word), data })
type Call = { status: string; logs: ReturnType<typeof log>[] }

/** The fill's pool log, then one call outcome below `threshold` gas and another from it up, as on Sepolia. */
function destination(estimate: bigint, threshold: bigint, below: Call, above: Call) {
	const simulated: bigint[] = []
	const blocks: (bigint | undefined)[] = []
	const pub = {
		getBlockNumber: async () => BLOCK,
		estimateGas: async ({ blockNumber }: { blockNumber?: bigint }) => {
			blocks.push(blockNumber)
			return estimate
		},
		simulateBlocks: async ({ blockNumber, blocks: b }: { blockNumber?: bigint; blocks: { calls: { gas: bigint }[] }[] }) => {
			const { gas } = b[0].calls[0]
			simulated.push(gas)
			blocks.push(blockNumber)
			return [{ calls: [gas >= threshold ? above : below] }]
		},
	}
	const dest = { public: pub, wallet: { account: { address: `0x${"ca".repeat(20)}` } } } as unknown as Destination
	return { dest, simulated, blocks }
}

const filled = log("0x5b", ["f1"])
// The relay's output moves by the same Transfer event either way; only its recipient tells delivery from recovery.
const delivered: Call = { status: "success", logs: [filled, log("0xe0", ["dd", "5b", "e0"], word("01"))] }

describe("fillGas", () => {
	it.each<[string, Call]>([
		["its recipient", { status: "success", logs: [filled, log("0xe0", ["dd", "5b", "ca"], word("01"))] }],
		["its data", { status: "success", logs: [filled, log("0xe0", ["dd", "5b", "e0"], word("02"))] }],
		["its status", { status: "failure", logs: delivered.logs }],
	])(
		"sends with the smallest doubling of the estimate whose outcome on one block equals the cap's, not one differing in %s",
		async (_, recovered) => {
			// Sepolia's node estimated 1,076,281 for a fill whose deposit needs 1,395,000; at 1.15× it was recovered.
			const { dest, simulated, blocks } = destination(600_000n, 1_395_000n, recovered, delivered)
			expect(await fillGas(dest, POOL, "0x" as Hex)).toBe(2_400_000n)
			expect(simulated).toEqual([TX_GAS_CAP, 1_200_000n, 2_400_000n])
			expect(blocks).toEqual([BLOCK, BLOCK, BLOCK, BLOCK])
		},
	)

	it("falls back to the cap when no smaller doubling reaches the outcome the cap simulates", async () => {
		const { dest } = destination(1_000_000n, 16_000_001n, { status: "success", logs: [filled] }, delivered)
		expect(await fillGas(dest, POOL, "0x" as Hex)).toBe(TX_GAS_CAP)
	})

	it("refuses a fill that fails even at the cap", async () => {
		const failed: Call = { status: "failure", logs: [] }
		const { dest } = destination(600_000n, 0n, failed, failed)
		await expect(fillGas(dest, POOL, "0x" as Hex)).rejects.toThrow(/fails in simulation even at the 16777216 gas cap/)
	})
})
