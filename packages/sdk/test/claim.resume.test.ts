import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import type { BridgeError } from "../src/errors.ts"
import type { TransferEvent } from "../src/events.ts"
import type { FuelClaimInteraction } from "../src/execution/fuel-claim.ts"
import { FeeStopError } from "../src/execution/fee-stop.ts"
import { claimFuel } from "../src/fuel/index.ts"
import { type Network, parseNetwork } from "../src/network.ts"
import { feeJuiceAddress } from "../src/protocol/fee-juice.ts"
import type { DepositRecord } from "../src/records.ts"
import { readsOf, testnet, worldOf } from "./fakes.ts"

vi.mock("../src/protocol/generation-record.ts", async (importOriginal) =>
	(await import("./fakes.ts")).withSyntheticCode(await importOriginal()),
)
vi.mock("../src/execution/hub-l2.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/execution/hub-l2.ts")>()),
	hubBindingAt: async () => undefined,
}))
const claim = vi.hoisted(() => ({ interaction: undefined as FuelClaimInteraction | undefined }))
vi.mock("../src/execution/fuel-claim.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/execution/fuel-claim.ts")>()),
	buildFuelClaimInteraction: async () => claim.interaction,
}))
vi.mock("../src/execution/wallet-fee-budget.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/execution/wallet-fee-budget.ts")>()),
	walletMaxFees: async () => ({ feePerDaGas: 1n, feePerL2Gas: 1n }),
}))
const found = vi.hoisted(() => ({ txHash: `0x${"de".repeat(32)}` }))
vi.mock("../src/execution/deposit-reconcile.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/execution/deposit-reconcile.ts")>()),
	findDepositTx: vi.fn(async () => ({ txHash: found.txHash })),
}))
vi.mock("../src/execution/send-flow.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/execution/send-flow.ts")>()),
	readSendInbox: async () => "0x0000000000000000000000000000000000000001",
	readSendReceiptLeaves: async () => ({ fuelLeafIndex: 4n, fuelMessageHashHex: `0x${"04".repeat(32)}`, fuelReceived: 5n * 10n ** 18n }),
}))

const CLAIM_HASH = `0x${"0c".repeat(32)}`
let account: AztecAddress
beforeAll(async () => {
	account = await AztecAddress.random()
})
afterEach(() => {
	vi.useRealTimers()
})

type Receipt = { status: string; executionResult?: string } | undefined

/** A testnet whose node answers the arrival gates at once, with the claim receipts and the nullifier the test sets. */
async function setup(opts: { receipts?: Receipt[]; nullified?: boolean; ingested?: () => boolean; treeSizes?: number[] } = {}) {
	const w = worldOf(testnet())
	const base = readsOf(w)
	const receipts = [...(opts.receipts ?? [{ status: "checkpointed" }])]
	const node = {
		...(base.aztecNode as object),
		getL1ToL2MessageIndex: async () => ((opts.ingested?.() ?? true) ? (opts.treeSizes ? 10_000n : 0n) : undefined),
		getBlockData: async () => ({
			header: { state: { l1ToL2MessageTree: { nextAvailableLeafIndex: opts.treeSizes?.shift() ?? 4096 } } },
		}),
		getTxReceipt: vi.fn(async () => (receipts.length > 1 ? receipts.shift() : receipts[0])),
		getNullifierMembershipWitness: async () => (opts.nullified ? { index: 1n } : undefined),
	}
	const r = { ...base, aztecNode: node as never }
	const net = await parseNetwork(w.m, r)
	const wallet = {
		getChainInfo: async () => ({ chainId: new Fr(BigInt(net.l1ChainId)), version: new Fr(BigInt(net.rollupVersion)) }),
	}
	return { net, r, node, w, aztec: { wallet: wallet as never, account } }
}

function gasRecord(
	net: Network,
	patch: Partial<DepositRecord> = {},
	fuel: Partial<NonNullable<DepositRecord["fuel"]>> = {},
): DepositRecord {
	const secret = Fr.random().toString()
	return {
		schema: 3,
		id: `0x${"0a".repeat(32)}`,
		direction: "deposit",
		intent: "gas",
		isPrivate: false,
		amount: "40",
		createdAt: 1,
		updatedAt: 1,
		chainId: net.l1ChainId,
		portal: net.fuel.feeJuicePortal,
		bridge: feeJuiceAddress,
		recipient: account.toString(),
		secretHashHex: `0x${"0a".repeat(32)}`,
		depositTxHash: `0x${"d0".repeat(32)}`,
		leafIndex: "4",
		fuel: {
			amount: "40",
			secret,
			secretHashHex: `0x${"0a".repeat(32)}`,
			minOutput: "1",
			leafIndex: "4",
			messageHash: `0x${"04".repeat(32)}`,
			received: (5n * 10n ** 18n).toString(),
			...fuel,
		},
		...patch,
	} as DepositRecord
}

/** A claim interaction whose simulate passes and whose send returns `CLAIM_HASH`, counting both. */
function interaction(over: Partial<FuelClaimInteraction> = {}) {
	const calls = { simulate: 0, send: 0 }
	claim.interaction = {
		simulate: async () => {
			calls.simulate++
		},
		send: async () => {
			calls.send++
			return { txHash: CLAIM_HASH }
		},
		...over,
	}
	return calls
}

type Entry = { persisted: DepositRecord } | { event: TransferEvent }

function recorder(signal?: AbortSignal) {
	const entries: Entry[] = []
	const run = {
		persist: async (record: DepositRecord) => {
			entries.push({ persisted: structuredClone(record) })
		},
		onEvent: (event: TransferEvent) => {
			entries.push({ event })
		},
		...(signal ? { signal } : {}),
	}
	const types = () => entries.flatMap((e) => ("event" in e ? [e.event.type] : []))
	const last = () => entries.flatMap((e) => ("persisted" in e ? [e.persisted] : [])).at(-1)
	return { entries, run, types, last }
}

/** Advances the fake clock until `p` settles, however many waits it starts. */
async function drive<T>(p: Promise<T>): Promise<T> {
	let done = false
	p.then(
		() => {
			done = true
		},
		() => {
			done = true
		},
	)
	while (!done) await vi.advanceTimersByTimeAsync(1000)
	return p
}

const failure = (p: Promise<unknown>) =>
	p.then(
		() => expect.unreachable("the claim resolved"),
		(e: unknown) => e as BridgeError,
	)

describe("claimFuel", () => {
	it("claims a fresh public record: claim-sent after its hash persisted, settled after completion persisted", async () => {
		const { net, r, aztec } = await setup()
		const calls = interaction()
		const { entries, run, types } = recorder()
		const out = await claimFuel(net, r, aztec, gasRecord(net), run)
		expect([out.via, out.txHash, calls.send]).toEqual(["claim", CLAIM_HASH, 1])
		expect(types()).toEqual(["arrival", "arrival", "claimable", "claim-requested", "claim-sent", "claim-waiting", "settled"])
		const heldBefore = (type: string) => {
			const i = entries.findIndex((e) => "event" in e && e.event.type === type)
			return entries
				.slice(0, i)
				.flatMap((e) => ("persisted" in e ? [e.persisted] : []))
				.at(-1)
		}
		expect([heldBefore("claim-sent")?.claimTxHash, heldBefore("claim-sent")?.fuel?.claimTxHash]).toEqual([CLAIM_HASH, CLAIM_HASH])
		expect([heldBefore("settled")?.completedAt !== undefined, heldBefore("settled")?.fuel?.consumed]).toEqual([true, true])
	})

	it("refuses another account's record, and a wallet on another network, before any read", async () => {
		const { net, r, aztec } = await setup()
		const calls = interaction()
		const other = gasRecord(net, { recipient: (await AztecAddress.random()).toString() })
		expect((await failure(claimFuel(net, r, aztec, other, recorder().run))).code).toBe("invalid-request")
		const elsewhere = { ...aztec, wallet: { getChainInfo: async () => ({ chainId: new Fr(1n), version: new Fr(1n) }) } as never }
		const e = await failure(claimFuel(net, r, elsewhere, gasRecord(net), recorder().run))
		expect([e.code, e.submission, calls.simulate]).toEqual(["wrong-aztec-network", "none", 0])
	})

	it("resumes a sent claim that landed: settles with its hash once its nullifier shows, and sends nothing", async () => {
		const { net, r, aztec } = await setup({ nullified: true })
		const calls = interaction()
		const rec = recorder()
		const sent = gasRecord(net, { claimTxHash: CLAIM_HASH }, { claimAttempt: true, claimTxHash: CLAIM_HASH })
		const out = await claimFuel(net, r, aztec, sent, rec.run)
		expect([out.via, out.txHash, calls.send, calls.simulate]).toEqual(["claim", CLAIM_HASH, 0, 0])
		expect(rec.types()).toEqual(["claim-waiting", "claim-verifying", "settled"])
	})

	it("resumes a sent claim that dropped: clears both hashes and throws, and the next call claims once more", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout"] })
		const dropped = `0x${"0d".repeat(32)}`
		const { net, r, aztec } = await setup({ receipts: [...Array(3).fill({ status: "dropped" }), { status: "checkpointed" }] })
		const calls = interaction()
		const rec = recorder()
		const sent = gasRecord(net, { claimTxHash: dropped }, { claimAttempt: true, claimTxHash: dropped })
		const e = await drive(failure(claimFuel(net, r, aztec, sent, rec.run)))
		expect([e.code, e.retry, calls.send, rec.last()?.claimTxHash, rec.last()?.fuel?.claimTxHash]).toEqual([
			"claim-dropped",
			"safe",
			0,
			undefined,
			undefined,
		])
		const out = await drive(claimFuel(net, r, aztec, rec.last() as DepositRecord, recorder().run))
		expect([out.txHash, calls.send]).toEqual([CLAIM_HASH, 1])
	})

	it("a resumed hash that reverted with its gas still live was never this record's claim: cleared, and claimed again", async () => {
		const { net, r, aztec } = await setup({ receipts: [{ status: "checkpointed", executionResult: "reverted" }] })
		const calls = interaction()
		const rec = recorder()
		const sent = gasRecord(net, { claimTxHash: CLAIM_HASH }, { claimAttempt: true, claimTxHash: CLAIM_HASH })
		const e = await failure(claimFuel(net, r, aztec, sent, rec.run))
		expect([e.code, e.retry, calls.send, rec.last()?.completedAt, rec.last()?.fuel?.claimTxHash]).toEqual([
			"claim-reverted",
			"safe",
			0,
			undefined,
			undefined,
		])
	})

	it("a gas hash the top level lost is read as the ladder reads it: landed or pending stops, dropped claims again", async () => {
		const latched = { claimAttempt: true, claimAttemptAt: Date.now(), claimTxHash: `0x${"0d".repeat(32)}` }
		const stops = []
		for (const status of ["checkpointed", "proposed"]) {
			const { net, r, aztec } = await setup({ receipts: [{ status }] })
			const calls = interaction()
			const e = await failure(claimFuel(net, r, aztec, gasRecord(net, {}, latched), recorder().run))
			stops.push([e.code, e.stop, calls.send])
		}
		expect(stops).toEqual([
			["fee-stop", "fuel-already-claimed", 0],
			["fee-stop", "fuel-claim-pending", 0],
		])
		const { net, r, aztec } = await setup({ receipts: [{ status: "dropped" }, { status: "checkpointed" }] })
		const calls = interaction()
		const out = await claimFuel(net, r, aztec, gasRecord(net, {}, latched), recorder().run)
		expect([out.txHash, calls.send]).toEqual([CLAIM_HASH, 1])
	})

	it("an attempt latched without a hash: refuses while it may land, settles once its nullifier is on chain", async () => {
		const latched = { claimAttempt: true, claimAttemptAt: Date.now() }
		const live = await setup()
		const calls = interaction()
		const e = await failure(claimFuel(live.net, live.r, live.aztec, gasRecord(live.net, {}, latched), recorder().run))
		expect([e.code, e.submission, e.retry, calls.send]).toEqual(["claim-not-visible", "submitted", "after-wait", 0])
		const spent = await setup({ nullified: true })
		const out = await claimFuel(spent.net, spent.r, spent.aztec, gasRecord(spent.net, {}, latched), recorder().run)
		expect([out.via, calls.send]).toEqual(["claim", 0])
	})

	it("a record that lost its deposit hash and leaves finds them on Ethereum before it claims", async () => {
		const { net, r, aztec } = await setup()
		interaction()
		const rec = recorder()
		const lost = gasRecord(net, { depositTxHash: undefined, leafIndex: undefined }, { leafIndex: undefined, messageHash: undefined })
		await claimFuel(net, r, aztec, lost, rec.run)
		expect(rec.types()).toEqual([
			"deposit-recovery",
			"deposit-recovery",
			"deposit-confirmed",
			"arrival",
			"arrival",
			"claimable",
			"claim-requested",
			"claim-sent",
			"claim-waiting",
			"settled",
		])
		const confirmedAt = rec.entries.findIndex((e) => "event" in e && e.event.type === "deposit-confirmed")
		const held = rec.entries
			.slice(0, confirmedAt)
			.flatMap((e) => ("persisted" in e ? [e.persisted] : []))
			.at(-1)
		expect([held?.depositTxHash, held?.fuel?.leafIndex]).toEqual([found.txHash, "4"])
	})

	it("an abort while the message is in flight stops waiting with nothing latched or sent", async () => {
		const controller = new AbortController()
		const { net, r, aztec } = await setup({
			ingested: () => {
				controller.abort()
				return false
			},
		})
		const calls = interaction()
		const rec = recorder(controller.signal)
		const e = await failure(claimFuel(net, r, aztec, gasRecord(net), rec.run))
		expect([e.code, e.retry, calls.send, rec.last()?.fuel?.claimAttempt]).toEqual(["aborted", "after-wait", 0, undefined])
	})

	it("a message another claim spent settles as claimed elsewhere", async () => {
		const { net, r, aztec } = await setup({ nullified: true })
		const calls = interaction({
			simulate: async () => {
				throw new Error("No non-nullified L1 to L2 message found for message hash")
			},
		})
		const rec = recorder()
		const out = await claimFuel(net, r, aztec, gasRecord(net), rec.run)
		expect([out.via, out.record.claimedByOther, calls.send]).toEqual(["claimed-elsewhere", true, 0])
		expect(rec.types()).toEqual(["arrival", "arrival", "settled"])
	})

	it("a watch reports each poll, and a read the node does not answer as soon as it fails and once it answers again", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout"] })
		const { net, r, node, aztec } = await setup({ nullified: true })
		node.getTxReceipt.mockRejectedValueOnce(new Error("node down"))
		const rec = recorder()
		await drive(claimFuel(net, r, aztec, gasRecord(net, { claimTxHash: CLAIM_HASH }, { claimTxHash: CLAIM_HASH }), rec.run))
		const waits = rec.entries.flatMap((e) =>
			"event" in e && e.event.type === "claim-waiting" ? [[e.event.poll, e.event.unreachable]] : [],
		)
		expect(waits).toEqual([
			[1, 0],
			[1, 1],
			[2, 1],
			[2, 0],
		])
	})

	it("an aborted signal stops a watch before its first read, with nothing settled", async () => {
		const { net, r, node, aztec } = await setup()
		const controller = new AbortController()
		controller.abort()
		const rec = recorder(controller.signal)
		const sent = gasRecord(net, { claimTxHash: CLAIM_HASH }, { claimTxHash: CLAIM_HASH })
		const e = await failure(claimFuel(net, r, aztec, sent, rec.run))
		expect([e.code, node.getTxReceipt.mock.calls.length, rec.last()?.completedAt]).toEqual(["aborted", 0, undefined])
	})

	it("a deposit not mined yet says so before the run waits for it, and an abort there stops the wait", async () => {
		const { net, r, aztec } = await setup()
		const controller = new AbortController()
		const l1 = { ...(r.l1 as object), getTransactionReceipt: async () => Promise.reject(new Error("not found")) }
		const rec = recorder(controller.signal)
		rec.run.onEvent = (event) => {
			rec.entries.push({ event })
			if (event.type === "deposit-recovery" && event.stage === "waiting") controller.abort()
		}
		const unread = gasRecord(net, { leafIndex: undefined }, { leafIndex: undefined, messageHash: undefined })
		const e = await failure(claimFuel(net, { ...r, l1: l1 as never }, aztec, unread, rec.run))
		const stages = rec.entries.flatMap((x) => ("event" in x && x.event.type === "deposit-recovery" ? [x.event.stage] : []))
		expect([e.code, stages]).toEqual(["aborted", ["reading", "waiting"]])
	})

	it("a search that finds more than one deposit names that result and never retries", async () => {
		const { net, r, aztec } = await setup()
		const { findDepositTx } = await import("../src/execution/deposit-reconcile.ts")
		vi.mocked(findDepositTx).mockResolvedValueOnce("ambiguous")
		const lost = gasRecord(net, { depositTxHash: undefined, leafIndex: undefined }, { leafIndex: undefined, messageHash: undefined })
		const e = await failure(claimFuel(net, r, aztec, lost, recorder().run))
		expect([e.code, e.search, e.retry]).toEqual(["deposit-not-found", "ambiguous", "never"])
	})

	it("the checkpoint count never rises within a call and ends at 0", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout"] })
		// 1024 leaves a checkpoint: the message's is the tenth; the anchor reads 4, recedes to 2, then reaches 8.
		const { net, r, aztec } = await setup({ treeSizes: [5000, 3000, 8200, 10_001] })
		interaction()
		const rec = recorder()
		await drive(claimFuel(net, r, aztec, gasRecord(net), rec.run))
		const counts = rec.entries.flatMap((e) =>
			"event" in e && e.event.type === "arrival" && e.event.stage === "counting" ? [e.event.checkpointsLeft] : [],
		)
		expect(counts).toEqual([6, 2, 0])
	})

	it("a fee stop keeps its code; a refused prompt clears the latch and is safe to retry", async () => {
		const { net, r, aztec } = await setup()
		interaction({
			simulate: async () => {
				throw new FeeStopError("fpc-drift")
			},
		})
		const stop = await failure(claimFuel(net, r, aztec, gasRecord(net), recorder().run))
		expect([stop.code, stop.stop, stop.retry]).toEqual(["fee-stop", "fpc-drift", "never"])
		interaction({
			send: async () => {
				throw Object.assign(new Error("User rejected the request."), { code: 4001 })
			},
		})
		const rec = recorder()
		const refused = await failure(claimFuel(net, r, aztec, gasRecord(net), rec.run))
		expect([refused.code, refused.retry, rec.last()?.fuel?.claimAttempt]).toEqual(["user-rejected", "safe", false])
	})

	it("storage that refuses the attempt's latch fails the claim before the wallet is asked, safe to run again", async () => {
		const { net, r, aztec } = await setup()
		const calls = interaction()
		const run = { persist: async () => Promise.reject(new Error("quota")) }
		const e = await failure(claimFuel(net, r, aztec, gasRecord(net), run))
		expect([e.code, e.submission, e.retry, calls.send]).toEqual(["persist-failed", "submitted", "safe", 0])
	})
})
