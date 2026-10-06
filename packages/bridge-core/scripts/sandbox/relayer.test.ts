import type { Address, Hex } from "viem"
import { describe, expect, it } from "vitest"
import { FILLED_RELAY_TOPIC } from "../../src/crosschain-discovery"
import { type Destination, fillGas, TX_GAS_CAP } from "./relayer"

const POOL: Address = `0x${"5b".repeat(20)}`
const HEAD = 77n
const word = (b: string) => `0x${b.repeat(32)}`
const log = (address: string, topics: string[], data = "0x") => ({ address, topics: topics.map(word), data })
type Call = { status: string; logs?: { address: string; topics: string[]; data: string }[] }

/** One call outcome below `threshold` gas and another from it up, as on Sepolia; each read fails its first `lag` calls. */
function destination(estimate: bigint, threshold: bigint, below: Call, above: Call, lag = 0) {
	const simulated: bigint[] = []
	const blocks: (bigint | undefined)[] = []
	const heads: unknown[] = []
	let [simulationsMissing, estimatesMissing] = [lag, lag]
	const pub = {
		getBlockNumber: async (args: unknown) => {
			heads.push(args)
			return HEAD
		},
		estimateGas: async ({ blockNumber }: { blockNumber?: bigint }) => {
			if (estimatesMissing-- > 0) throw new Error("header not found")
			blocks.push(blockNumber)
			return estimate
		},
		simulateBlocks: async ({ blockNumber, blocks: b }: { blockNumber?: bigint; blocks: { calls: { gas: bigint }[] }[] }) => {
			if (simulationsMissing-- > 0) throw new Error("header not found")
			const { gas } = b[0].calls[0]
			simulated.push(gas)
			blocks.push(blockNumber)
			return [{ calls: [gas >= threshold ? above : below] }]
		},
	}
	const dest = { public: pub, wallet: { account: { address: `0x${"ca".repeat(20)}` } } } as unknown as Destination
	return { dest, simulated, blocks, heads }
}

const filled = { address: POOL, topics: [FILLED_RELAY_TOPIC], data: "0x" }
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
			const { dest, simulated, blocks, heads } = destination(600_000n, 1_395_000n, recovered, delivered)
			expect(await fillGas(dest, POOL, "0x" as Hex, HEAD - 1n)).toBe(2_400_000n)
			expect(simulated).toEqual([TX_GAS_CAP, 1_200_000n, 2_400_000n])
			expect(blocks).toEqual([HEAD, HEAD, HEAD, HEAD])
			expect(heads).toEqual([{ cacheTime: 0 }])
		},
	)

	it("never simulates before the approval, and waits out a backend that has not reached it", async () => {
		// The node's head predates the approval's block, and the first simulation and estimate land on a backend behind it.
		const { dest, blocks } = destination(600_000n, 0n, delivered, delivered, 1)
		expect(await fillGas(dest, POOL, "0x" as Hex, HEAD + 2n)).toBe(1_200_000n)
		expect(blocks).toEqual([HEAD + 2n, HEAD + 2n, HEAD + 2n])
	})

	it("falls back to the cap when no smaller doubling reaches the outcome the cap simulates", async () => {
		const { dest } = destination(1_000_000n, 16_000_001n, { status: "success", logs: [filled] }, delivered)
		expect(await fillGas(dest, POOL, "0x" as Hex, 0n)).toBe(TX_GAS_CAP)
	})

	it.each<[string, Call]>([
		["fails", { status: "failure", logs: [filled] }],
		["succeeds with its logs omitted", { status: "success" }],
		["succeeds with FilledRelay from another emitter", { status: "success", logs: [{ ...filled, address: `0x${"5e".repeat(20)}` }] }],
		["succeeds with another event from the pool", { status: "success", logs: [{ ...filled, topics: [word("f1")] }] }],
	])("refuses a fill that %s at the cap", async (_, atCap) => {
		const { dest } = destination(600_000n, 0n, atCap, atCap)
		await expect(fillGas(dest, POOL, "0x" as Hex, 0n)).rejects.toThrow(/logs no FilledRelay in simulation even at the 16777216 gas cap/)
	})
})
