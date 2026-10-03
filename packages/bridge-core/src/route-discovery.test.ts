import { describe, expect, it, vi } from "vitest"
import { type Address, decodeFunctionData, encodeFunctionResult, type Hex } from "viem"
import type { PoolKey } from "./l1"
import { type BatchQuoteClient, QUOTER_ABI } from "./quote"
import { type DiscoverRouteOptions, discoverFuelRoute } from "./route-discovery"

const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address
const NATIVE = addr(0)
const TOKEN = addr(0x1111)
const WETH = addr(0xeeee)
const FEE_JUICE = addr(0xf00d)
const QUOTER = addr(0x9999)
const MULTICALL3 = addr(0xca11)

interface Hop {
	poolKey: PoolKey
	zeroForOne: boolean
	exactAmount: bigint
}

/**
 * Answers each quoted hop by inspecting the real encoded calldata, so the fake exercises the
 * module's own encode/decode rather than a hand-written stand-in for it.
 */
function fakeClient(answer: (hop: Hop) => bigint | "revert") {
	const rounds: Hop[][] = []
	const readContract = vi.fn(async (args: { args: readonly [readonly { callData: Hex }[]] }) => {
		const hops = args.args[0].map((c) => decodeFunctionData({ abi: QUOTER_ABI, data: c.callData }).args[0] as Hop)
		rounds.push(hops)
		return hops.map((hop) => {
			const out = answer(hop)
			if (out === "revert") return { success: false, returnData: "0x" as Hex }
			const returnData = encodeFunctionResult({ abi: QUOTER_ABI, functionName: "quoteExactInputSingle", result: [out, 0n] })
			return { success: true, returnData }
		})
	})
	return { client: { readContract } as unknown as BatchQuoteClient, rounds, readContract }
}

const isEthFjHop = (hop: Hop) => hop.poolKey.currency0 === NATIVE

const options = (client: BatchQuoteClient, over: Partial<DiscoverRouteOptions> = {}): DiscoverRouteOptions => ({
	client,
	quoter: QUOTER,
	multicall3: MULTICALL3,
	token: TOKEN,
	feeAsset: FEE_JUICE,
	weth: WETH,
	feeJuice: FEE_JUICE,
	tiers: [{ fee: 500, tickSpacing: 10 }],
	ethFj: { fee: 10_000, tickSpacing: 200 },
	probeAmount: 1_000_000n,
	...over,
})

describe("discoverFuelRoute", () => {
	it("short-circuits the fee asset itself without touching the network", async () => {
		const { client, readContract } = fakeClient(() => 1n)
		expect(await discoverFuelRoute(options(client, { token: FEE_JUICE }))).toEqual({ kind: "identity" })
		expect(readContract).not.toHaveBeenCalled()
	})

	it("routes WETH through the single native→FeeJuice hop", async () => {
		const { client, rounds } = fakeClient(() => 7n)
		const outcome = await discoverFuelRoute(options(client, { token: WETH }))
		expect(outcome).toEqual({
			kind: "route",
			quoteOut: 7n,
			route: {
				path: [{ currency0: NATIVE, currency1: FEE_JUICE, fee: 10_000, tickSpacing: 200, hooks: NATIVE }],
				zeroForOnes: [true],
			},
		})
		expect(rounds).toHaveLength(1)
	})

	it("keeps the one tier that has liquidity and re-batches only the survivor", async () => {
		const tiers = [
			{ fee: 500, tickSpacing: 10 },
			{ fee: 3000, tickSpacing: 60 },
			{ fee: 10_000, tickSpacing: 200 },
		]
		const { client, rounds } = fakeClient((hop) => (isEthFjHop(hop) ? hop.exactAmount * 2n : hop.poolKey.fee === 3000 ? 5n : 0n))
		const outcome = await discoverFuelRoute(options(client, { tiers }))
		expect(outcome.kind === "route" && outcome.route.path[0].fee).toBe(3000)
		expect(outcome.kind === "route" && outcome.quoteOut).toBe(10n)
		expect(rounds.map((r) => r.length)).toEqual([3, 1])
	})

	it("picks the tier with the largest output when several quote", async () => {
		const tiers = [
			{ fee: 500, tickSpacing: 10 },
			{ fee: 3000, tickSpacing: 60 },
		]
		const { client } = fakeClient((hop) => (isEthFjHop(hop) ? hop.exactAmount * 2n : hop.poolKey.fee === 3000 ? 300n : 100n))
		const outcome = await discoverFuelRoute(options(client, { tiers }))
		expect(outcome.kind === "route" && outcome.route.path[0].fee).toBe(3000)
		expect(outcome.kind === "route" && outcome.quoteOut).toBe(600n)
	})

	it("reports no-route when every tier reverts or quotes zero (initialized is not liquid)", async () => {
		const tiers = [
			{ fee: 500, tickSpacing: 10 },
			{ fee: 3000, tickSpacing: 60 },
			{ fee: 10_000, tickSpacing: 200 },
		]
		const { client, rounds } = fakeClient((hop) => (hop.poolKey.fee === 3000 ? "revert" : 0n))
		expect(await discoverFuelRoute(options(client, { tiers }))).toEqual({ kind: "no-route", tried: 3 })
		expect(rounds).toHaveLength(1)
	})

	it("a thrown batch is transport-unavailable, not a missing route", async () => {
		const client = { readContract: vi.fn().mockRejectedValue(new Error("fetch failed")) } as unknown as BatchQuoteClient
		expect(await discoverFuelRoute(options(client))).toEqual({ kind: "unavailable", reason: "rpc" })
	})

	it("is config-unavailable with no tiers to probe or no probe amount", async () => {
		const { client, readContract } = fakeClient(() => 1n)
		expect(await discoverFuelRoute(options(client, { tiers: [] }))).toEqual({ kind: "unavailable", reason: "config" })
		expect(await discoverFuelRoute(options(client, { probeAmount: 0n }))).toEqual({ kind: "unavailable", reason: "config" })
		expect(readContract).not.toHaveBeenCalled()
	})
})
