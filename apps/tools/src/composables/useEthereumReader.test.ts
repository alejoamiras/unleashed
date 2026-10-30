import { createPublicClient, type Hex, http } from "viem"
import { afterEach, describe, expect, it, vi } from "vitest"
import { __resetReadClientsForTests, discoveryReadsFor, readClientFor } from "./useEthereumReader"

const BASE_SEPOLIA = 84532
const SEPOLIA = 11155111
const PUBLICNODE = "https://base-sepolia-rpc.publicnode.com"
const OFFICIAL = "https://sepolia.base.org"
const SEPOLIA_PUBLICNODE = "https://ethereum-sepolia-rpc.publicnode.com"
const PANDAOPS = "https://rpc.sepolia.ethpandaops.io"
const HEAD = 10_000_000n
/** One block older than the 3,000,000 PublicNode Base Sepolia is trusted for. */
const OLD = HEAD - 3_000_000n
/** Where the stubbed PublicNode endpoints stop keeping history: below it, logs answer `[]` and receipts `null`. */
const PRUNED_BELOW = HEAD - 1_000_000n
const OLD_TX = `0x${"ab".repeat(32)}` as const
/** Mined at `OLD` too, with no receipt on any endpoint. */
const LOST_TX = `0x${"cd".repeat(32)}` as const

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
	const kept = url.includes("publicnode") ? PRUNED_BELOW : 0n
	const result = Array.from({ length: Number(to - from + 1n) }, (_, i) => from + BigInt(i))
		.filter((b) => b >= kept)
		.map((b) => ({ blockNumber: at(b), topics: [] }))
	return rpc({ jsonrpc: "2.0", id, result })
}

/** `eth_blockNumber`, and the transaction and receipt of a hash mined at `OLD`: `null` on PublicNode or for `LOST_TX`. */
function historyAnswer(id: number, url: string, method: string, hash: string) {
	const at = (n: bigint) => `0x${n.toString(16)}`
	if (method === "eth_blockNumber") return rpc({ jsonrpc: "2.0", id, result: at(HEAD) })
	const tx = { hash, blockHash: hash, blockNumber: at(OLD), transactionHash: hash, transactionIndex: "0x0" }
	if (method === "eth_getTransactionByHash") return rpc({ jsonrpc: "2.0", id, result: tx })
	const receipt = { ...tx, status: "0x1", logs: [], from: hash.slice(0, 42), to: null, gasUsed: "0x1", type: "0x2" }
	return rpc({ jsonrpc: "2.0", id, result: url.includes("publicnode") || hash === LOST_TX ? null : receipt })
}

/** A JSON-RPC endpoint per URL: a number answers `eth_chainId`, `eth_getLogs` and the history methods, "down" answers 503. */
function stubRpcs(answers: Record<string, number | "down">) {
	const asked: string[] = []
	const calls: { url: string; method: string }[] = []
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
			calls.push({ url, method })
			if (HISTORY.has(method)) return historyAnswer(id, url, method, String(params?.[0]))
			if (method !== "eth_getLogs") return rpc({ jsonrpc: "2.0", id, result: `0x${answer.toString(16)}` })
			if (url === OFFICIAL) logRanges.push([BigInt(params[0].fromBlock), BigInt(params[0].toBlock)])
			return logsAnswer(id, url, params[0])
		}),
	)
	return { asked, calls, logRanges }
}

const HISTORY = new Set(["eth_blockNumber", "eth_getTransactionByHash", "eth_getTransactionReceipt"])

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

	it("reads history a first endpoint no longer keeps from the next one, never from its short answer", async () => {
		const { calls } = stubRpcs({
			[PUBLICNODE]: BASE_SEPOLIA,
			[OFFICIAL]: BASE_SEPOLIA,
			[SEPOLIA_PUBLICNODE]: SEPOLIA,
			[PANDAOPS]: SEPOLIA,
		})
		const asked = (url: string, method: string) => calls.filter((c) => c.url === url && c.method === method)
		const base = readClientFor(BASE_SEPOLIA)

		const old = await base?.getLogs({ fromBlock: OLD, toBlock: OLD + 1_999n })
		expect(old).toHaveLength(2_000)
		expect(asked(PUBLICNODE, "eth_getLogs")).toEqual([])
		expect(asked(OFFICIAL, "eth_getLogs")).toHaveLength(10)

		const recent = await base?.getLogs({ fromBlock: HEAD - 1_999n, toBlock: HEAD })
		expect(recent).toHaveLength(2_000)
		expect(asked(PUBLICNODE, "eth_getLogs")).toHaveLength(1)
		expect(asked(OFFICIAL, "eth_getLogs")).toHaveLength(10)

		const receipt = await readClientFor(SEPOLIA)?.getTransactionReceipt({ hash: OLD_TX })
		expect(receipt?.blockNumber).toBe(OLD)
		expect(asked(SEPOLIA_PUBLICNODE, "eth_getTransactionReceipt")).toHaveLength(1)
		expect(asked(PANDAOPS, "eth_getTransactionReceipt")).toHaveLength(1)

		// The last endpoint's `null` stays viem's "not found", which polling and discovery read as absent.
		const lost = readClientFor(SEPOLIA)?.getTransactionReceipt({ hash: LOST_TX })
		await expect(lost).rejects.toMatchObject({ name: "TransactionReceiptNotFoundError" })
		expect(asked(PANDAOPS, "eth_getTransactionReceipt")).toHaveLength(2)
	})

	it("has no reader for a chain the build pins no RPC for, rather than borrowing the wallet's", () => {
		// Base mainnet is a known source, but the testnet build pins no read RPC for it.
		expect(readClientFor(8453)).toBeUndefined()
		expect(readClientFor(1)).toBeUndefined()
		expect(discoveryReadsFor(8453)).toBeUndefined()
		expect(discoveryReadsFor(BASE_SEPOLIA)).toBeDefined()
		expect(readClientFor(SEPOLIA)?.chain?.id).toBe(SEPOLIA)
	})

	it("builds every reader with ccipRead: false, so a read stays on the pinned RPCs", () => {
		expect([readClientFor(SEPOLIA)?.ccipRead, readClientFor(BASE_SEPOLIA)?.ccipRead]).toEqual([false, false])
	})
})

/**
 * The testnet build's Sepolia readers, opt-in: `RPC_CAPS_LIVE=1`. PublicNode refuses logs past its floor and answers
 * their receipts `null`; through `readClientFor` both resolve from ethPandaOps, whose recent answer equals PublicNode's.
 * Every compared answer is non-empty, so two empty answers never pass.
 */
describe.skipIf(!process.env.RPC_CAPS_LIVE)("readClientFor against Sepolia's keyless RPCs", () => {
	const WETH = "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14"
	const id = (l: { transactionHash: Hex | null; logIndex: number | null }) => `${l.transactionHash}:${l.logIndex}`

	it("reads logs and receipts past PublicNode's floor from ethPandaOps", async () => {
		const reads = readClientFor(SEPOLIA)
		const head = (await reads?.getBlockNumber()) ?? 0n
		const old = { address: WETH, fromBlock: head - 20_000n, toBlock: head - 19_000n } as const
		const logs = (await reads?.getLogs(old)) ?? []
		expect(logs.length).toBeGreaterThan(0)
		const publicnode = createPublicClient({ transport: http(SEPOLIA_PUBLICNODE, { retryCount: 0 }) })
		await expect(publicnode.getLogs(old)).rejects.toMatchObject({ code: 4444 })

		const hash = logs[0].transactionHash as Hex
		await expect(publicnode.getTransactionReceipt({ hash })).rejects.toThrow(/could not be found/)
		await expect(reads?.getTransactionReceipt({ hash })).resolves.toMatchObject({ transactionHash: hash })

		const recent = { address: WETH, fromBlock: head - 2_100n, toBlock: head - 101n } as const
		const pandaops = createPublicClient({ transport: http(PANDAOPS) })
		const [ours, theirs] = await Promise.all([publicnode.getLogs(recent), pandaops.getLogs(recent)])
		expect(ours.length).toBeGreaterThan(0)
		expect(theirs.map(id)).toEqual(ours.map(id))
	}, 120_000)
})
