import { createPublicClient, custom, fallback, type Hex, http, numberToHex, pad, RpcRequestError } from "viem"
import { describe, expect, it } from "vitest"
import { cappedLogs } from "./capped-logs"
import { SOURCE_CHAINS } from "./source-chains"

const WETH = "0x4200000000000000000000000000000000000006"
const OFFICIAL = "https://sepolia.base.org"
const PUBLICNODE = "https://base-sepolia-rpc.publicnode.com"

const refusal = (code: number, message: string) => new RpcRequestError({ body: {}, error: { code, message }, url: "http://stub.test" })

/**
 * An endpoint that refuses `to − from > limit` (200 by default, as `sepolia.base.org` does), else answers one log per
 * block whose `data` is `tag`. `fail` makes its `at`-th log request throw or answer `null`, or every request fail.
 */
function endpoint(tag: Hex, fail?: { at: number; with: "error" | "null" } | "down", limit = 200n) {
	const calls: [bigint, bigint][] = []
	const transport = custom({
		async request({ method, params }: { method: string; params?: unknown }) {
			if (method !== "eth_getLogs") throw refusal(-32601, "method not found")
			if (fail === "down") throw refusal(-32000, "endpoint down")
			const { address, fromBlock, toBlock } = (params as [{ address?: string; fromBlock: Hex; toBlock: Hex }])[0]
			if (address?.toLowerCase() !== WETH) throw refusal(-32602, "the filter lost its address")
			const [from, to] = [BigInt(fromBlock), BigInt(toBlock)]
			calls.push([from, to])
			if (to - from > limit) throw refusal(-32614, `eth_getLogs is limited to a ${limit} range`)
			if (typeof fail === "object" && calls.length === fail.at) {
				if (fail.with === "null") return null
				throw refusal(-32000, "header not found")
			}
			return Array.from({ length: Number(to - from + 1n) }, (_, i) => ({
				address: WETH,
				blockHash: pad(numberToHex(from + BigInt(i)), { size: 32 }),
				blockNumber: numberToHex(from + BigInt(i)),
				data: tag,
				logIndex: "0x0",
				removed: false,
				topics: [],
				transactionHash: pad(numberToHex(from + BigInt(i)), { size: 32 }),
				transactionIndex: "0x0",
			}))
		},
	})
	return { transport, calls }
}

const scan = (transport: Parameters<typeof createPublicClient>[0]["transport"], fromBlock: bigint, toBlock: bigint) =>
	createPublicClient({ transport }).getLogs({ address: WETH, fromBlock, toBlock })

const blocks = (from: bigint, to: bigint) => Array.from({ length: Number(to - from + 1n) }, (_, i) => from + BigInt(i))

describe("cappedLogs", () => {
	it("answers a range past the cap in requests within it, in block order, through a fallback", async () => {
		const capped = endpoint("0x01")
		const transport = fallback([endpoint("0x00", "down").transport, cappedLogs(capped.transport, 200)])

		const logs = await scan(transport, 1_000n, 3_049n)
		expect(logs.map((l) => l.blockNumber)).toEqual(blocks(1_000n, 3_049n))
		expect(capped.calls).toHaveLength(11)
		capped.calls.forEach(([from, to], i) => {
			expect(to - from + 1n).toBeLessThanOrEqual(200n)
			expect(from).toBe(i === 0 ? 1_000n : capped.calls[i - 1][1] + 1n)
		})
		expect(capped.calls.at(-1)).toEqual([3_000n, 3_049n])

		capped.calls.length = 0
		expect(await scan(transport, 5_000n, 5_149n)).toHaveLength(150)
		expect(capped.calls).toEqual([[5_000n, 5_149n]])

		for (const bad of [0, -1, 1.5, Number.NaN]) expect(() => cappedLogs(capped.transport, bad)).toThrow(/positive integer/)
	})

	it.each(["error", "null"] as const)("never answers part of a range when a request fails (%s)", async (failure) => {
		const alone = endpoint("0x01", { at: 4, with: failure })
		await expect(scan(cappedLogs(alone.transport, 200), 1_000n, 2_999n)).rejects.toThrow()
		expect(alone.calls).toHaveLength(4)

		const first = endpoint("0x01", { at: 4, with: failure })
		const backup = endpoint("0x02", undefined, 50_000n)
		const logs = await scan(fallback([cappedLogs(first.transport, 200), backup.transport]), 1_000n, 2_999n)
		expect(first.calls).toHaveLength(4)
		expect(backup.calls).toEqual([[1_000n, 2_999n]])
		expect(logs.map((l) => l.blockNumber)).toEqual(blocks(1_000n, 2_999n))
		expect(new Set(logs.map((l) => l.data))).toEqual(new Set(["0x02"]))
	})
})

/**
 * Base Sepolia's keyless RPCs, opt-in: `RPC_CAPS_LIVE=1`. Each catalogued cap is served and a range two blocks past
 * it is refused with the endpoint's own code, never answered short; the official endpoint's split answer equals
 * PublicNode's single answer over a recent range. A cap the endpoint moves fails here first.
 */
describe.skipIf(!process.env.RPC_CAPS_LIVE)("cappedLogs against Base Sepolia's keyless RPCs", () => {
	const REFUSAL: Record<string, number> = { [OFFICIAL]: -32614, [PUBLICNODE]: -32701 }

	it("serves each cap, refuses past it, and splits to PublicNode's answer", async () => {
		const chain = SOURCE_CHAINS[84532]
		const to = (await createPublicClient({ transport: http(PUBLICNODE) }).getBlockNumber()) - 500n
		for (const [url, cap] of Object.entries(chain.maxLogBlocks ?? {})) {
			const endpoint = http(url, { retryCount: 0 })
			await expect(scan(endpoint, to - BigInt(cap) + 1n, to)).resolves.toBeInstanceOf(Array)
			const refused: unknown = await scan(endpoint, to - BigInt(cap) - 1n, to).then(
				() => "answered",
				(e: unknown) => e,
			)
			expect((refused as { code?: number }).code, url).toBe(REFUSAL[url])
		}

		const id = (l: { transactionHash: Hex | null; logIndex: number | null }) => `${l.transactionHash}:${l.logIndex}`
		const wide = await scan(http(PUBLICNODE), to - 1_999n, to)
		const split = await scan(cappedLogs(http(OFFICIAL), 200), to - 1_999n, to)
		expect(wide.length).toBeGreaterThan(0)
		expect(split.map(id)).toEqual(wide.map(id))
	}, 120_000)
})
