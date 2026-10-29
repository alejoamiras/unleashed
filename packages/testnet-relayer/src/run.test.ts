import { FillRefused, FUNDS_DEPOSITED, fillSourceDeposit, type SourceDeposit } from "@unleashed/bridge-core/across-fill"
import { encodeAbiParameters, encodeEventTopics, type Hex, keccak256, pad, toHex } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import manifest from "../../../apps/tools/public/testnet-bridge.json"
import { appDeposit } from "../test/app-deposit"
import type { RelayLine } from "./log"
import { testnetRoute } from "./route"
import { type RelayConfig, relayOnce, relayPass } from "./run"

vi.mock("@unleashed/bridge-core/across-fill", async (importOriginal) => ({
	...(await importOriginal<typeof import("@unleashed/bridge-core/across-fill")>()),
	fillSourceDeposit: vi.fn(),
}))
const fill = vi.mocked(fillSourceDeposit)

const ACCOUNT = privateKeyToAccount(`0x${"11".repeat(32)}`)
const FILLER = ACCOUNT.address
const route = testnetRoute(manifest, FILLER)
const NOW = 1_800_000_000
const SOURCE_HEAD = 50_000_000n
const STRANGER = privateKeyToAccount(`0x${"22".repeat(32)}`).address

/** One `FundsDeposited` log of `d`, as the source pool emits it in block `blockNumber`. */
function depositLog(d: SourceDeposit, tx: number, logIndex = 0, blockNumber = SOURCE_HEAD - 10n) {
	const r = d.relay
	const nonIndexed = FUNDS_DEPOSITED.inputs.filter((i) => !i.indexed)
	const values: Record<string, unknown> = { ...r, quoteTimestamp: d.quoteTimestamp }
	return {
		address: route.source.spokePool,
		topics: encodeEventTopics({
			abi: [FUNDS_DEPOSITED],
			args: { destinationChainId: d.destinationChainId, depositId: r.depositId, depositor: r.depositor },
		}),
		data: encodeAbiParameters(
			nonIndexed,
			nonIndexed.map((i) => values[i.name] as never),
		),
		transactionHash: pad(toHex(tx)),
		blockNumber,
		logIndex,
	}
}

interface Chains {
	deposits?: ReturnType<typeof depositLog>[]
	/** Source logs for one range, in place of the deposits that fall in it. */
	logs?: (fromBlock: bigint, toBlock: bigint) => Promise<unknown[]>
	/** Source blocks to a second, the head stamped `NOW`: Base Sepolia makes five. */
	perSecond?: bigint
	/** Sepolia's head time. */
	destinationTime?: number
	/** The filler's nonce, in place of an answer at once. */
	nonce?: () => Promise<number>
	/** `FilledRelay` arguments the destination pool logged. */
	fills?: Record<string, unknown>[]
	sourceChainId?: number
	destinationChainId?: number
	token?: bigint
	pending?: number
	maxFeePerGas?: bigint
}

/** Stubbed endpoints for one pass, recording every method called on them and every source log range read. */
function config(o: Chains, signer = ACCOUNT) {
	const calls: string[] = []
	const ranges: [bigint, bigint][] = []
	const lines: RelayLine[] = []
	const record = <T extends object>(target: T) =>
		new Proxy(target, {
			get: (t, key) => {
				const v = (t as Record<string | symbol, unknown>)[key]
				if (typeof v !== "function") return v
				return (...a: unknown[]) => {
					calls.push(String(key))
					return v(...a)
				}
			},
		})
	const source = record({
		getChainId: async () => o.sourceChainId ?? 84532,
		getBlockNumber: async () => SOURCE_HEAD,
		getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({
			number: blockNumber,
			timestamp: BigInt(NOW) - (SOURCE_HEAD - blockNumber) / (o.perSecond ?? 5n),
		}),
		getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
			ranges.push([fromBlock, toBlock])
			if (o.logs) return o.logs(fromBlock, toBlock)
			return (o.deposits ?? []).filter((l) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock)
		},
	})
	const pub = record({
		getChainId: async () => o.destinationChainId ?? 11155111,
		getBalance: async () => 10n ** 17n,
		readContract: async () => o.token ?? 100_000_000n,
		getBlock: async () => ({ number: 5_000n, timestamp: BigInt(o.destinationTime ?? NOW) }),
		getLogs: async ({ fromBlock }: { fromBlock: bigint }) =>
			fromBlock === 5_000n - 800n ? (o.fills ?? []).map((args) => ({ args })) : [],
		getTransactionCount: async ({ blockTag }: { blockTag: string }) =>
			o.nonce ? o.nonce() : blockTag === "pending" ? (o.pending ?? 0) : 0,
		estimateFeesPerGas: async () => ({ maxFeePerGas: o.maxFeePerGas ?? 34n, maxPriorityFeePerGas: 2n }),
	})
	const c: RelayConfig = {
		source: source as never,
		destination: { public: pub, wallet: { account: signer } } as never,
		route,
		log: (l: RelayLine) => lines.push(l),
	}
	return { c, lines, calls, ranges }
}

const deposit = (input: bigint, depositId: bigint, head = NOW - 600) => appDeposit({ input, filler: FILLER, depositId, head })
const filledOk = { fillTxHash: pad("0xf1") as Hex, relayHash: pad("0x1") as Hex, alreadyFilled: false }

beforeEach(() => {
	fill.mockReset()
	fill.mockResolvedValue(filledOk)
})
afterEach(() => {
	vi.useRealTimers()
})

describe("relayOnce", () => {
	it("refuses another chain or another signer before any other read", async () => {
		for (const chains of [{ sourceChainId: 1 }, { destinationChainId: 1 }]) {
			const wrongChain = config({ ...chains, deposits: [depositLog(deposit(5_000_000n, 1n), 1)] })
			expect(await relayOnce(wrongChain.c)).toEqual({ outcome: "refused" })
			expect(wrongChain.calls).toEqual(["getChainId", "getChainId"])
		}
		const stranger = config({ deposits: [depositLog(deposit(5_000_000n, 1n), 1)] }, privateKeyToAccount(`0x${"22".repeat(32)}`))
		expect(await relayOnce(stranger.c)).toEqual({ outcome: "refused" })
		expect(stranger.calls).toEqual(["getChainId", "getChainId"])
		expect(stranger.lines).toEqual([{ event: "refused", reason: expect.stringMatching(/not the filler/) }])
	})

	it("fills the largest deposit once, by its transaction and vetted relay hash", async () => {
		const small = deposit(2_000_000n, 1n)
		const large = deposit(6_000_000n, 2n)
		const { c, lines } = config({ deposits: [depositLog(small, 1), depositLog(large, 2)] })
		expect(await relayOnce(c)).toEqual({ outcome: "filled", fillTx: filledOk.fillTxHash })
		expect(fill).toHaveBeenCalledTimes(1)
		expect(fill.mock.calls[0]?.[1]).toBe(pad(toHex(2)))
		expect(fill.mock.calls[0]?.[2]).toEqual({ relayHash: expect.stringMatching(/^0x/) })
		expect(lines.at(-1)).toMatchObject({ event: "filled", output: large.relay.outputAmount })
	})

	it("drops deposits filled by full identity, late or above the float, with no per-deposit read", async () => {
		const filled = deposit(6_000_000n, 1n)
		const late = deposit(5_000_000n, 2n, NOW - 7_200)
		const costly = deposit(8_000_000n, 3n)
		const { relay } = filled
		const { message, ...fields } = relay
		const fillOf = { ...fields, messageHash: keccak256(message) }
		const { c, lines, calls } = config({
			deposits: [filled, late, costly].map((d, i) => depositLog(d, i + 1)),
			fills: [fillOf],
			token: 5_000_000n,
		})
		expect(await relayOnce(c)).toEqual({ outcome: "idle" })
		expect(fill).not.toHaveBeenCalled()
		expect(calls.filter((m) => m === "readContract")).toEqual(["readContract"])
		expect(lines.filter((l) => l.event === "skipped").map((l) => l.reason)).toEqual(["deadline", "balance"])
	})

	it("still fills a deposit whose id a stranger's fill of another relay reused", async () => {
		const d = deposit(5_000_000n, 7n)
		const { message: _, ...fields } = d.relay
		const forged = {
			...fields,
			recipient: pad("0xbad", { size: 32 }),
			exclusiveRelayer: pad("0x0", { size: 32 }),
			messageHash: pad("0x0"),
		}
		const { c } = config({ deposits: [depositLog(d, 1)], fills: [forged] })
		expect(await relayOnce(c)).toMatchObject({ outcome: "filled" })
	})

	it("ignores a transaction holding two deposits, whichever is ours", async () => {
		const { c, lines } = config({ deposits: [depositLog(deposit(5_000_000n, 1n), 1, 0), depositLog(deposit(4_000_000n, 2n), 1, 1)] })
		expect(await relayOnce(c)).toEqual({ outcome: "idle" })
		expect(fill).not.toHaveBeenCalled()
		expect(lines.map((l) => l.reason)).toEqual(["ambiguous", "ambiguous"])
	})

	it("sends nothing while the filler has a transaction out or a fill at the gas cap would pass the ceiling", async () => {
		const deposits = [depositLog(deposit(5_000_000n, 1n), 1)]
		expect(await relayOnce(config({ deposits, pending: 1 }).c)).toEqual({ outcome: "busy" })
		expect(await relayOnce(config({ deposits, maxFeePerGas: 300_000_000n }).c)).toEqual({ outcome: "gas-price" })
		expect(fill).not.toHaveBeenCalled()
	})

	it("passes a write-free refusal to the next candidate and ends on anything that may have written", async () => {
		const deposits = [6_000_000n, 5_000_000n, 4_000_000n].map((input, i) => depositLog(deposit(input, BigInt(i + 1)), i + 1))
		fill.mockRejectedValueOnce(new FillRefused("unfillable", "no FilledRelay")).mockRejectedValueOnce(
			new FillRefused("fill-reverted", "reverted"),
		)
		const { c, lines } = config({ deposits })
		expect(await relayOnce(c)).toEqual({ outcome: "failed" })
		expect(fill).toHaveBeenCalledTimes(2)
		expect(lines.map((l) => [l.event, l.reason])).toEqual([
			["skipped", "unfillable"],
			["failed", "reverted"],
		])

		fill.mockReset()
		fill.mockResolvedValue({ ...filledOk, fillTxHash: null, alreadyFilled: true })
		expect(await relayOnce(config({ deposits }).c)).toEqual({ outcome: "already-filled", fillTx: null })
		expect(fill).toHaveBeenCalledTimes(1)
	})

	it("tries a larger send before any dust, and at most eight candidates a pass", async () => {
		const dust = Array.from({ length: 20 }, (_, i) => depositLog(deposit(3n, BigInt(i + 1)), i + 1))
		const send = depositLog(deposit(5_000_000n, 99n), 99)
		fill.mockRejectedValue(new FillRefused("unfillable", "no FilledRelay"))
		const { c } = config({ deposits: [...dust, send] })
		expect(await relayOnce(c)).toEqual({ outcome: "skipped" })
		expect(fill).toHaveBeenCalledTimes(8)
		expect(fill.mock.calls[0]?.[1]).toBe(send.transactionHash)
	})
	it("reads every source block of the last 7,800 s by Sepolia's clock, and fills a deposit 200 s before its deadline", async () => {
		const old = deposit(5_000_000n, 1n, NOW - 7_000)
		const { c, ranges } = config({ deposits: [depositLog(old, 1, 0, SOURCE_HEAD - 35_000n)], destinationTime: NOW - 12 })
		expect(await relayOnce(c)).toEqual({ outcome: "filled", fillTx: filledOk.fillTxHash })
		expect(fill.mock.calls[0]?.[1]).toBe(pad(toHex(1)))
		// Sepolia's head time less 7,800 s is 39,064 Base Sepolia blocks of 0.2 s back.
		expect(ranges[0]?.[0]).toBe(SOURCE_HEAD - 39_064n)
		expect(ranges.at(-1)?.[1]).toBe(SOURCE_HEAD - 2n)
		expect(ranges).toHaveLength(20)
		expect(ranges.slice(1).every(([from], i) => from === (ranges[i]?.[1] ?? 0n) + 1n)).toBe(true)
	})

	it("logs an ignored deposit in the 30 s after its block, and not later", async () => {
		const stranger = (id: bigint, head: number) => appDeposit({ input: 5_000_000n, filler: STRANGER, depositId: id, head })
		const fresh = depositLog(stranger(1n, NOW - 20), 1, 0, SOURCE_HEAD - 100n)
		const stale = depositLog(stranger(2n, NOW - 120), 2, 0, SOURCE_HEAD - 600n)
		const { c, lines } = config({ deposits: [fresh, stale] })
		expect(await relayOnce(c)).toEqual({ outcome: "idle" })
		expect(lines).toEqual([{ event: "ignored", reason: "relayer", srcTx: fresh.transactionHash }])
	})

	it("fails closed, sending nothing, when the window passes the block cap or the reads pass 45 s", async () => {
		const fast = config({ perSecond: 20n, deposits: [depositLog(deposit(5_000_000n, 1n), 1)] })
		expect(await relayOnce(fast.c)).toEqual({ outcome: "failed" })
		expect(fast.lines).toEqual([{ event: "failed", reason: expect.stringMatching(/passes 100000 source blocks/) }])
		expect(fast.calls).not.toContain("getLogs")

		vi.useFakeTimers()
		const at = SOURCE_HEAD - 18_000n
		const ours = depositLog(deposit(5_000_000n, 1n, NOW - 3_600), 1, 0, at)
		const fresh = depositLog(appDeposit({ input: 5_000_000n, filler: STRANGER, depositId: 2n, head: NOW }), 2, 0, SOURCE_HEAD - 10n)
		let reached = () => {}
		const atStall = new Promise<void>((r) => {
			reached = r
		})
		let release = () => {}
		const stalled = new Promise<unknown[]>((r) => {
			release = () => r([fresh])
		})
		// The chunk at the head stalls; released, it holds a deposit `ignored` would log.
		const slow = config({
			logs: async (from, to) => {
				if (to < SOURCE_HEAD - 2n) return from <= at && at <= to ? [ours] : []
				reached()
				return stalled
			},
		})
		const pass = relayOnce(slow.c)
		await atStall
		await vi.advanceTimersByTimeAsync(45_000)
		expect(await pass).toEqual({ outcome: "failed" })
		expect(slow.lines).toEqual([{ event: "failed", reason: expect.stringMatching(/passed their 45 s/) }])
		const reads = slow.calls.length
		release()
		await vi.advanceTimersByTimeAsync(20_000)
		expect(slow.calls).toHaveLength(reads)
		expect(slow.lines).toHaveLength(1)
		expect(fill).not.toHaveBeenCalled()
	})

	it("starts a try only with 25 s left in the run, after a pending check raced to that cutoff", async () => {
		vi.useFakeTimers()
		const deposits = [6_000_000n, 5_000_000n].map((input, i) => depositLog(deposit(input, BigInt(i + 1)), i + 1))
		const late = config({ deposits })
		expect(await relayPass(late.c, { runEnd: Date.now() + 20_000 })).toEqual({ outcome: "late" })
		expect(late.calls).not.toContain("getTransactionCount")
		expect(late.lines).toEqual([{ event: "late" }])

		fill.mockImplementationOnce(async () => {
			vi.setSystemTime(Date.now() + 10_000)
			throw new FillRefused("unfillable", "no FilledRelay")
		})
		const slow = config({ deposits })
		expect(await relayPass(slow.c, { runEnd: Date.now() + 30_000 })).toEqual({ outcome: "late" })
		expect(fill).toHaveBeenCalledTimes(1)
		expect(slow.calls.filter((m) => m === "getTransactionCount")).toHaveLength(2)
		expect(slow.lines.map((l) => l.event)).toEqual(["skipped", "late"])

		const stuck = config({ deposits, nonce: () => new Promise(() => {}) })
		const pass = relayPass(stuck.c, { runEnd: Date.now() + 30_000 })
		await vi.advanceTimersByTimeAsync(5_000)
		expect(await pass).toEqual({ outcome: "late" })
		expect(fill).toHaveBeenCalledTimes(1)
	})
})
