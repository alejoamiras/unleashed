import { FillRefused, FUNDS_DEPOSITED, fillSourceDeposit, type SourceDeposit } from "@unleashed/bridge-core/across-fill"
import { encodeAbiParameters, encodeEventTopics, type Hex, keccak256, pad, toHex } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { beforeEach, describe, expect, it, vi } from "vitest"
import manifest from "../../../apps/tools/public/testnet-bridge.json"
import { appDeposit } from "../test/app-deposit"
import type { RelayLine } from "./log"
import { testnetRoute } from "./route"
import { type RelayConfig, relayOnce } from "./run"

vi.mock("@unleashed/bridge-core/across-fill", async (importOriginal) => ({
	...(await importOriginal<typeof import("@unleashed/bridge-core/across-fill")>()),
	fillSourceDeposit: vi.fn(),
}))
const fill = vi.mocked(fillSourceDeposit)

const ACCOUNT = privateKeyToAccount(`0x${"11".repeat(32)}`)
const FILLER = ACCOUNT.address
const route = testnetRoute(manifest, FILLER)
const NOW = 1_800_000_000
const SOURCE_HEAD = 10_000n

/** One `FundsDeposited` log of `d`, as the source pool emits it. */
function depositLog(d: SourceDeposit, tx: number, logIndex = 0) {
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
		blockNumber: SOURCE_HEAD - 10n,
		logIndex,
	}
}

interface Chains {
	deposits?: ReturnType<typeof depositLog>[]
	/** `FilledRelay` arguments the destination pool logged. */
	fills?: Record<string, unknown>[]
	sourceChainId?: number
	token?: bigint
	pending?: number
	maxFeePerGas?: bigint
}

/** Stubbed endpoints for one run, recording every method called on them. */
function config(o: Chains, signer = ACCOUNT): { c: RelayConfig; lines: RelayLine[]; calls: string[] } {
	const calls: string[] = []
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
		getLogs: async ({ fromBlock }: { fromBlock: bigint }) => (fromBlock === SOURCE_HEAD - 2n - 4_000n ? (o.deposits ?? []) : []),
	})
	const pub = record({
		getChainId: async () => 11155111,
		getBalance: async () => 10n ** 17n,
		readContract: async () => o.token ?? 100_000_000n,
		getBlock: async () => ({ number: 5_000n, timestamp: BigInt(NOW) }),
		getLogs: async ({ fromBlock }: { fromBlock: bigint }) =>
			fromBlock === 5_000n - 800n ? (o.fills ?? []).map((args) => ({ args })) : [],
		getTransactionCount: async ({ blockTag }: { blockTag: string }) => (blockTag === "pending" ? (o.pending ?? 0) : 0),
		estimateFeesPerGas: async () => ({ maxFeePerGas: o.maxFeePerGas ?? 34n, maxPriorityFeePerGas: 2n }),
	})
	const c = {
		source: source as never,
		destination: { public: pub, wallet: { account: signer } } as never,
		route,
		log: (l: RelayLine) => lines.push(l),
	}
	return { c, lines, calls }
}

const deposit = (input: bigint, depositId: bigint, head = NOW - 600) => appDeposit({ input, filler: FILLER, depositId, head })
const filledOk = { fillTxHash: pad("0xf1") as Hex, relayHash: pad("0x1") as Hex, alreadyFilled: false }

beforeEach(() => {
	fill.mockReset()
	fill.mockResolvedValue(filledOk)
})

describe("relayOnce", () => {
	it("refuses another chain or another signer before any other read", async () => {
		const wrongChain = config({ sourceChainId: 1, deposits: [depositLog(deposit(5_000_000n, 1n), 1)] })
		expect(await relayOnce(wrongChain.c)).toEqual({ outcome: "refused" })
		expect(wrongChain.calls).toEqual(["getChainId", "getChainId"])
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

	it("tries a larger send before any dust, and at most eight candidates a run", async () => {
		const dust = Array.from({ length: 20 }, (_, i) => depositLog(deposit(3n, BigInt(i + 1)), i + 1))
		const send = depositLog(deposit(5_000_000n, 99n), 99)
		fill.mockRejectedValue(new FillRefused("unfillable", "no FilledRelay"))
		const { c } = config({ deposits: [...dust, send] })
		expect(await relayOnce(c)).toEqual({ outcome: "skipped" })
		expect(fill).toHaveBeenCalledTimes(8)
		expect(fill.mock.calls[0]?.[1]).toBe(send.transactionHash)
	})
})
