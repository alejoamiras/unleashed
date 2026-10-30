import type { PublicClient } from "viem"
import { describe, expect, it } from "vitest"
import type { Network } from "../network.ts"
import { FEE_BOUND_MULTIPLE, feeBoundOf } from "./fee-bound.ts"

const REGISTRY = "0x00000000000000000000000000000000000000e1"
const ROLLUP = "0x00000000000000000000000000000000000000e2"
const BLOCK = 812n
const NOW = 1_800_000_000n
const SLOT = 36n
const net = { l1ChainId: 11155111, fuel: { registry: REGISTRY } } as unknown as Network

/** An Ethereum reader whose rollup answers `fees` for the timestamps two slots before, at and two slots after the
 *  latest block's, recording every read. */
function reader(fees: [bigint, bigint, bigint], opts: { chainId?: number; fail?: string } = {}) {
	const reads: { functionName: string; address: string; args?: readonly unknown[]; blockNumber?: bigint }[] = []
	const byTime = new Map([
		[NOW - 2n * SLOT, fees[0]],
		[NOW, fees[1]],
		[NOW + 2n * SLOT, fees[2]],
	])
	const l1 = {
		getChainId: async () => opts.chainId ?? 11155111,
		getBlock: async () => ({ number: BLOCK, timestamp: NOW }),
		readContract: async (q: { functionName: string; address: string; args?: readonly unknown[]; blockNumber?: bigint }) => {
			reads.push(q)
			if (q.functionName === opts.fail) throw new Error("rpc down")
			if (q.functionName === "getCanonicalRollup") return ROLLUP
			if (q.functionName === "getSlotDuration") return SLOT
			const fee = byTime.get(q.args?.[0] as bigint)
			if (fee === undefined || q.args?.[1] !== true) throw new Error(`unexpected read ${q.functionName}(${q.args})`)
			return fee
		},
	}
	return { r: { l1: l1 as unknown as PublicClient }, reads }
}

describe("feeBoundOf", () => {
	it("is DA 0 and the multiple of the highest sample, whether it falls before, at or after the latest block", async () => {
		for (const fees of [
			[9n, 4n, 4n],
			[4n, 9n, 4n],
			[4n, 4n, 9n],
		] as [bigint, bigint, bigint][]) {
			const { r, reads } = reader(fees)
			expect(await feeBoundOf(net, r)).toEqual({ feePerDaGas: 0n, feePerL2Gas: FEE_BOUND_MULTIPLE * 9n })
			expect(reads.map((q) => q.blockNumber)).toEqual(Array(5).fill(BLOCK))
			expect(reads.slice(0, 2).map((q) => [q.functionName, q.address])).toEqual([
				["getCanonicalRollup", REGISTRY],
				["getSlotDuration", ROLLUP],
			])
		}
	})

	it("throws on another chain's reader, and on any failed read", async () => {
		await expect(feeBoundOf(net, reader([1n, 1n, 1n], { chainId: 1 }).r)).rejects.toThrow("chain 1")
		await expect(feeBoundOf(net, reader([1n, 1n, 1n], { fail: "getManaMinFeeAt" }).r)).rejects.toThrow("rpc down")
		await expect(feeBoundOf(net, reader([1n, 1n, 1n], { fail: "getCanonicalRollup" }).r)).rejects.toThrow("rpc down")
	})
})
