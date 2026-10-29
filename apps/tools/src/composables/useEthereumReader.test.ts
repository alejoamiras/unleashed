import { afterEach, describe, expect, it, vi } from "vitest"
import { __resetReadClientsForTests, discoveryReadsFor, readClientFor } from "./useEthereumReader"

const BASE_SEPOLIA = 84532
const SEPOLIA = 11155111
const PUBLICNODE = "https://base-sepolia-rpc.publicnode.com"
const OFFICIAL = "https://sepolia.base.org"

afterEach(() => {
	vi.unstubAllGlobals()
	__resetReadClientsForTests()
})

const rpc = (body: object) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } })

/** One log per block of `[from, to]`, refused when `to − from > 200` as `sepolia.base.org` refuses it. */
function logsAnswer(id: number, url: string, filter: { fromBlock: string; toBlock: string }) {
	const [from, to] = [BigInt(filter.fromBlock), BigInt(filter.toBlock)]
	if (url === OFFICIAL && to - from > 200n) {
		return rpc({ jsonrpc: "2.0", id, error: { code: -32614, message: "eth_getLogs is limited to a 200 range" } })
	}
	const at = (n: bigint) => `0x${n.toString(16)}`
	const result = Array.from({ length: Number(to - from + 1n) }, (_, i) => ({ blockNumber: at(from + BigInt(i)), topics: [] }))
	return rpc({ jsonrpc: "2.0", id, result })
}

/** A JSON-RPC endpoint per URL: a number answers `eth_chainId` and `eth_getLogs`, "down" answers 503. */
function stubRpcs(answers: Record<string, number | "down">) {
	const asked: string[] = []
	const logRanges: [bigint, bigint][] = []
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input instanceof Request ? input.url : input).replace(/\/$/, "")
			asked.push(url)
			const answer = answers[url]
			if (answer === undefined || answer === "down") return new Response("unavailable", { status: 503 })
			const { id, method, params } = JSON.parse(String(init?.body)) as {
				id: number
				method: string
				params: [{ fromBlock: string; toBlock: string }]
			}
			if (method !== "eth_getLogs") return rpc({ jsonrpc: "2.0", id, result: `0x${answer.toString(16)}` })
			if (url === OFFICIAL) logRanges.push([BigInt(params[0].fromBlock), BigInt(params[0].toBlock)])
			return logsAnswer(id, url, params[0])
		}),
	)
	return { asked, logRanges }
}

describe("readClientFor — reads that need no wallet", () => {
	it("reads a source chain through its pinned RPCs, the next one when the first is down", async () => {
		const { asked } = stubRpcs({ [PUBLICNODE]: "down", [OFFICIAL]: BASE_SEPOLIA })
		const client = readClientFor(BASE_SEPOLIA)
		expect(client?.chain?.id).toBe(BASE_SEPOLIA)
		await expect(client?.getChainId()).resolves.toBe(BASE_SEPOLIA)
		expect(asked[0]).toBe(PUBLICNODE)
		expect(asked.at(-1)).toBe(OFFICIAL)
		expect(readClientFor(BASE_SEPOLIA)).toBe(client)
	})

	it("keeps a log scan that falls back to the official endpoint within its 200-block cap", async () => {
		const { logRanges } = stubRpcs({ [PUBLICNODE]: "down", [OFFICIAL]: BASE_SEPOLIA })
		const logs = await readClientFor(BASE_SEPOLIA)?.getLogs({ fromBlock: 1_000n, toBlock: 2_999n })
		expect(logs?.map((l) => l.blockNumber)).toEqual(Array.from({ length: 2_000 }, (_, i) => 1_000n + BigInt(i)))
		expect(logRanges).toHaveLength(10)
		expect(logRanges.every(([from, to]) => to - from < 200n)).toBe(true)
	})

	it("has no reader for a chain the build pins no RPC for, rather than borrowing the wallet's", () => {
		// Base mainnet is a known source, but the testnet build pins no read RPC for it.
		expect(readClientFor(8453)).toBeUndefined()
		expect(readClientFor(1)).toBeUndefined()
		expect(discoveryReadsFor(8453)).toBeUndefined()
		expect(discoveryReadsFor(BASE_SEPOLIA)).toBeDefined()
		expect(readClientFor(SEPOLIA)?.chain?.id).toBe(SEPOLIA)
	})
})
