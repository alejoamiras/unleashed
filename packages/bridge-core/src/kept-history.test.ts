import { createPublicClient, custom, fallback, type Hex, http, numberToHex, pad, RpcRequestError } from "viem"
import { describe, expect, it } from "vitest"
import { cappedLogs } from "./capped-logs"
import { keptLogs, receiptOrNext } from "./kept-history"
import { SOURCE_CHAINS } from "./source-chains"

const WETH = "0x4200000000000000000000000000000000000006"
const OFFICIAL = "https://sepolia.base.org"
const PUBLICNODE = "https://base-sepolia-rpc.publicnode.com"
const HEAD = 10_000n

const refusal = (code: number, message: string) => new RpcRequestError({ body: {}, error: { code, message }, url: "http://stub.test" })
/** A transaction's hash encodes the block it was mined in; a hash above the head names no transaction. */
const txAt = (block: bigint) => pad(numberToHex(block), { size: 32 })
const UNKNOWN = txAt(HEAD + 1n)

interface Options {
	/** Below this block, logs answer `[]` and receipts `null` without an error, as PublicNode Base Sepolia does. */
	prunedBelow?: bigint
	/** Blocks whose receipts answer `null` for the first `n` reads: mined, not indexed yet. */
	lagging?: Map<bigint, number>
	failProbe?: "eth_getTransactionByHash" | "eth_blockNumber"
	down?: boolean
	/** The head moves one block per `eth_blockNumber`, so a receipt waiter sees new blocks. */
	advancing?: boolean
}

/** An endpoint that serves logs (one per block, `data` = `tag`), transactions and receipts, and records each method. */
function endpoint(tag: Hex, o: Options = {}) {
	const calls: { method: string; from?: bigint; to?: bigint }[] = []
	let head = HEAD
	const floor = o.prunedBelow ?? 0n
	const logs = (from: bigint, to: bigint) =>
		Array.from({ length: Number(to - from + 1n) }, (_, i) => from + BigInt(i))
			.filter((b) => b >= floor)
			.map((b) => ({ address: WETH, blockNumber: numberToHex(b), data: tag, logIndex: "0x0", topics: [], transactionHash: txAt(b) }))
	const receipt = (block: bigint) => {
		const left = o.lagging?.get(block)
		if (left !== undefined && left > 0) {
			o.lagging?.set(block, left - 1)
			return null
		}
		if (block < floor) return null
		const at = { blockHash: txAt(block), blockNumber: numberToHex(block), transactionHash: txAt(block) }
		return { ...at, status: "0x1", from: WETH, to: WETH, logs: [], transactionIndex: "0x0", type: "0x2", gasUsed: "0x1" }
	}
	const getLogs = (filter: Record<string, string>) => {
		if (filter.blockHash) {
			calls.push({ method: "eth_getLogs" })
			return []
		}
		const [from, to] = [BigInt(filter.fromBlock), BigInt(filter.toBlock)]
		calls.push({ method: "eth_getLogs", from, to })
		return logs(from, to)
	}
	const byHash = (method: string, hash: string, answer: (block: bigint) => unknown) => {
		calls.push({ method })
		const block = BigInt(hash)
		return block > HEAD ? null : answer(block)
	}
	const handlers: Record<string, (first: never) => unknown> = {
		eth_chainId: () => "0x14a34",
		eth_blockNumber: () => {
			if (o.advancing) head += 1n
			return numberToHex(head)
		},
		eth_getLogs: getLogs,
		eth_getTransactionByHash: (hash: string) =>
			byHash("eth_getTransactionByHash", hash, (block) => ({ hash, blockNumber: numberToHex(block) })),
		eth_getTransactionReceipt: (hash: string) => byHash("eth_getTransactionReceipt", hash, receipt),
	}
	const transport = custom({
		async request({ method, params }: { method: string; params?: unknown }) {
			if (o.down) throw refusal(-32000, "endpoint down")
			if (o.failProbe === method) throw refusal(-32000, "header not found")
			const handler = handlers[method]
			if (!handler) throw refusal(-32601, "method not found")
			return handler(((params ?? []) as never[])[0])
		},
	})
	const asked = (method: string) => calls.filter((c) => c.method === method)
	return { transport, calls, asked }
}

const client = (transport: Parameters<typeof createPublicClient>[0]["transport"]) => createPublicClient({ transport, pollingInterval: 5 })
const scan = (transport: Parameters<typeof createPublicClient>[0]["transport"], fromBlock: bigint, toBlock: bigint) =>
	client(transport).getLogs({ address: WETH, fromBlock, toBlock })
const tags = (logs: readonly { data: Hex }[]) => new Set(logs.map((l) => l.data))

describe("keptLogs", () => {
	it("sends a log query older than the retention to the next endpoint, never answering it short", async () => {
		const pruned = endpoint("0x01", { prunedBelow: 6_000n })
		const full = endpoint("0x02")
		const transport = fallback([keptLogs(pruned.transport, 4_000), full.transport])

		// Below the floor, and starting one block under the first kept block (6,001), only `full` answers.
		for (const [from, to] of [
			[5_000n, 5_999n],
			[6_000n, 7_000n],
		] as const) {
			const logs = await scan(transport, from, to)
			expect(logs).toHaveLength(Number(to - from + 1n))
			expect(tags(logs)).toEqual(new Set(["0x02"]))
		}
		const byHash = await client(transport).getLogs({ address: WETH, blockHash: txAt(5_500n) })
		expect(byHash).toEqual([])
		expect(pruned.asked("eth_getLogs")).toEqual([])
		expect(full.asked("eth_getLogs")).toHaveLength(3)

		const kept = await scan(transport, 6_001n, 7_000n)
		expect(kept).toHaveLength(1_000)
		expect(tags(kept)).toEqual(new Set(["0x01"]))

		const alone = scan(keptLogs(pruned.transport, 4_000), 5_000n, 5_999n)
		await expect(alone).rejects.toMatchObject({ code: 4444 })
		expect(pruned.asked("eth_getLogs")).toEqual([{ method: "eth_getLogs", from: 6_001n, to: 7_000n }])

		for (const bad of [0, -1, 1.5, Number.NaN]) expect(() => keptLogs(pruned.transport, bad)).toThrow(/positive integer/)
	})
})

describe("receiptOrNext", () => {
	const setup = (o: Options = {}, fullOptions: Options = {}) => {
		const pruned = endpoint("0x01", { prunedBelow: 6_000n, ...o })
		const full = endpoint("0x02", fullOptions)
		return { pruned, full, reads: client(fallback([receiptOrNext(pruned.transport), full.transport])) }
	}

	it("asks the next endpoint for a receipt the first no longer keeps", async () => {
		const { full, reads } = setup()
		const receipt = await reads.getTransactionReceipt({ hash: txAt(5_000n) })
		expect(receipt.blockNumber).toBe(5_000n)
		expect(full.asked("eth_getTransactionReceipt")).toHaveLength(1)

		// Either side of the 1,000-block line, with the first endpoint not holding either receipt yet.
		const lagging = new Map([
			[9_000n, 1],
			[9_001n, 1],
		])
		const line = setup({ lagging })
		expect((await line.reads.getTransactionReceipt({ hash: txAt(9_000n) })).blockNumber).toBe(9_000n)
		expect(line.full.asked("eth_getTransactionReceipt")).toHaveLength(1)
		await expect(line.reads.getTransactionReceipt({ hash: txAt(9_001n) })).rejects.toThrow(/could not be found/)
		expect(line.full.asked("eth_getTransactionReceipt")).toHaveLength(1)
	})

	it.each([
		["an unknown transaction", {}, UNKNOWN],
		["a failed transaction probe", { failProbe: "eth_getTransactionByHash" }, txAt(5_000n)],
		["a failed head probe", { failProbe: "eth_blockNumber" }, txAt(5_000n)],
	] as const)("keeps the first endpoint's null for %s", async (_, o, hash) => {
		const { full, reads } = setup(o)
		await expect(reads.getTransactionReceipt({ hash })).rejects.toThrow(/could not be found/)
		expect(full.asked("eth_getTransactionReceipt")).toEqual([])
	})

	it("keeps polling a fresh send's receipt with the next endpoint down", async () => {
		const { pruned, reads } = setup({ lagging: new Map([[9_500n, 3]]), advancing: true }, { down: true })
		// Replacement checks read blocks, not receipts; they are not what this pins.
		const receipt = await reads.waitForTransactionReceipt({ hash: txAt(9_500n), timeout: 5_000, checkReplacement: false })
		expect(receipt.blockNumber).toBe(9_500n)
		expect(pruned.asked("eth_getTransactionReceipt").length).toBeGreaterThan(3)
	})
})

/**
 * PublicNode Base Sepolia's retention, opt-in: `RPC_CAPS_LIVE=1`. At the oldest block the catalogue trusts it for, its
 * answer equals the official endpoint's, both non-empty, so two empty answers never pass. A retention PublicNode
 * shrank past the catalogued one fails here first.
 */
describe.skipIf(!process.env.RPC_CAPS_LIVE)("keptLogs against Base Sepolia's keyless RPCs", () => {
	it("serves PublicNode's catalogued retention in full", async () => {
		const kept = BigInt(SOURCE_CHAINS[84532].logRetentionBlocks?.[PUBLICNODE] ?? 0)
		const head = await createPublicClient({ transport: http(PUBLICNODE) }).getBlockNumber()
		const from = head - kept + 1n
		const id = (l: { transactionHash: Hex | null; logIndex: number | null }) => `${l.transactionHash}:${l.logIndex}`
		const publicnode = await scan(http(PUBLICNODE), from, from + 1_999n)
		const official = await scan(cappedLogs(http(OFFICIAL), 200), from, from + 1_999n)
		expect(official.length).toBeGreaterThan(0)
		expect(publicnode.map(id)).toEqual(official.map(id))
	}, 60_000)
})
