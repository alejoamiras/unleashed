/**
 * Records older builds stored, claimed through the SDK with no migration: each shape reaches the entry that claims it as
 * its claim view, and a claim's writes land on the stored record in its own shape.
 */
import { type AnyJournalRecord, type KV, claimView, loadAllRecords } from "@unleashed/bridge-core"
import type { JournalTokenBlock } from "@unleashed/sdk"
import { feeJuiceAddress, predictPortal } from "@unleashed/sdk/protocol"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { FEE_STOP_COPY } from "@/lib/fee-stop-copy"
import { xcRecord } from "@/test/crosschain-record"

vi.mock("@/contracts/bridge-generation", () => ({ FUEL_PORTAL: "0xfd05ee8687d4ca828ba3d26ef04b80dd1348e5bd" }))

import { CLAIM_TX as CLAIM, FAKE_NETWORK, type FakeClaimSdk, fakeClaimSdk, sendsClaim } from "./test/fake-claim-sdk"
import {
	__resetJournalForTests,
	addRecord,
	connectJournalDeps,
	resumeSessionWork,
	runDepositClaim,
	updateCrossChainRecord,
	useBridgeJournal,
} from "./useBridgeJournal"

const FACTORY = "0x5eb3bc0a489c5a8288765d2336659ebca68fcd00"
const IMPLEMENTATION = "0xc95ff0608561b6ba084c78d14f09e9826190f968"
const ERC20 = "0x70e0ba845a1a0f2da3359c97e0285013525ffc49"
const HUB = `0x${"b".repeat(64)}`
const FJ_PORTAL = "0xfd05ee8687d4ca828ba3d26ef04b80dd1348e5bd"
const CLONE = predictPortal(FACTORY, IMPLEMENTATION, ERC20)
const RECIPIENT = "0x1018808f2c17794badb361c02c945582b8198b495a7e8d01154f7eeb7d719c0d"
const word = (b: string) => `0x${b.repeat(32)}`

const TOKEN: JournalTokenBlock = {
	erc20: ERC20,
	portal: CLONE,
	l2Token: word("cc"),
	nameWord: word("11"),
	symbolWord: word("22"),
	decimals: 6,
	displaySymbol: "USDC",
}

const FUEL = {
	amount: "250",
	secret: word("f0"),
	secretHashHex: word("fe"),
	minOutput: "450",
	leafIndex: "8",
	messageHash: word("8e"),
	received: "5",
}

const common = {
	direction: "deposit",
	isPrivate: false,
	amount: "100",
	createdAt: 1,
	updatedAt: 1,
	chainId: 11155111,
	recipient: RECIPIENT,
}

/** A direct Fee Juice bridge an older build stored: its gas block holds the leaves the claim reads. */
const schema2 = (over: Record<string, unknown> = {}) =>
	({
		...common,
		schema: 2,
		id: word("02"),
		assetKind: "fee-juice",
		portal: FJ_PORTAL,
		bridge: feeJuiceAddress.toString(),
		secret: word("5e"),
		secretHashHex: word("02"),
		leafIndex: "8",
		depositTxHash: word("d2"),
		fuel: FUEL,
		...over,
	}) as unknown as AnyJournalRecord

const schema3 = (over: Record<string, unknown> = {}) =>
	({
		...common,
		schema: 3,
		id: word("03"),
		intent: "token",
		token: TOKEN,
		portal: CLONE,
		bridge: HUB,
		secret: word("5f"),
		secretHashHex: word("03"),
		leafIndex: "7",
		messageHash: word("7e"),
		depositTxHash: word("d3"),
		...over,
	}) as unknown as AnyJournalRecord

/** A gas-only send: its one claim secret and its leaves live in the gas block. */
const gasOnly = (over: Record<string, unknown> = {}) =>
	schema3({
		id: word("0a"),
		intent: "gas",
		token: undefined,
		secret: undefined,
		portal: FJ_PORTAL,
		bridge: feeJuiceAddress.toString(),
		secretHashHex: word("0a"),
		leafIndex: undefined,
		messageHash: undefined,
		fuel: FUEL,
		...over,
	})

const schema4 = (over: Record<string, unknown> = {}) =>
	xcRecord({
		id: word("04"),
		secretHashHex: word("04"),
		recipient: RECIPIENT,
		portal: CLONE,
		bridge: HUB,
		token: TOKEN,
		intent: "token",
		fuel: undefined,
		leafIndex: "7",
		messageHash: word("7f"),
		depositTxHash: word("d4"),
		...over,
	} as never) as unknown as AnyJournalRecord

function memKV(): KV {
	const store = new Map<string, string>()
	return { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, v), removeItem: (k) => void store.delete(k) }
}

const stored = (kv: KV, id: string) => loadAllRecords(kv).find((r) => r.id === id) as Record<string, unknown> | undefined

describe("persisted records claim through their views", () => {
	let kv: KV
	let sdk: FakeClaimSdk

	beforeEach(() => {
		__resetJournalForTests()
		kv = memKV()
		sdk = fakeClaimSdk()
		connectJournalDeps({
			kv,
			now: () => 999,
			waitMs: async () => {},
			connectedAztec: () => RECIPIENT,
			sendBinding: () => ({ factory: FACTORY, implementation: IMPLEMENTATION, hub: HUB, feeJuicePortal: FJ_PORTAL }),
			validateTokenBlock: vi.fn(async () => null),
			ensureTokenGrant: vi.fn(async () => "granted" as const),
			...sdk.deps,
		})
	})

	it.each([
		["schema 2 Fee Juice", schema2, "fuel", ["schema", "assetKind"]],
		["schema 3", schema3, "token", ["schema", "intent"]],
		["schema 4", schema4, "token", ["schema", "route", "sender"]],
	] as const)("a %s claim in flight resumes on load, watching, and lands in the record's own shape", async (_n, make, entry, kept) => {
		const rec = make({ claimTxHash: CLAIM })
		addRecord(rec as never)
		const before = stored(kv, rec.id) as Record<string, unknown>
		resumeSessionWork()
		await vi.waitFor(() => expect(stored(kv, rec.id)?.completedAt).toBeDefined())
		expect(sdk.calls).toHaveLength(1)
		expect(sdk.calls[0]).toMatchObject({ entry, view: claimView(before as never), run: { watchOnly: true } })
		const after = stored(kv, rec.id) as Record<string, unknown>
		for (const k of kept) expect(after[k]).toEqual(before[k])
		expect(after.claimTxHash).toBe(CLAIM)
	})

	it("a gas-only record holding only its gas block's claim hash reaches the gas claim with that hash", async () => {
		const rec = gasOnly({ fuel: { ...FUEL, claimAttempt: true, claimTxHash: CLAIM } })
		addRecord(rec as never)
		await runDepositClaim(rec.id)
		expect(sdk.calls).toHaveLength(1)
		expect(sdk.calls[0]?.entry).toBe("fuel")
		expect(sdk.calls[0]?.view.claimTxHash).toBeUndefined()
		expect(sdk.calls[0]?.view.fuel?.claimTxHash).toBe(CLAIM)
	})

	it("a record holding its leaves but no deposit hash claims; one missing both waits for its flow", async () => {
		addRecord(schema3({ depositTxHash: undefined }) as never)
		await runDepositClaim(word("03"))
		expect(sdk.calls.map((c) => c.entry)).toEqual(["token"])

		addRecord(
			schema2({
				id: word("05"),
				secretHashHex: word("05"),
				depositTxHash: undefined,
				fuel: { ...FUEL, received: undefined },
			}) as never,
		)
		await runDepositClaim(word("05"))
		expect(sdk.calls).toHaveLength(1)
		expect(useBridgeJournal().runtime.value[word("05")]?.attention).toBeUndefined()
	})

	it("a schema 2 deposit missing its leaves says it predates the bridge, and claims nothing", async () => {
		addRecord(schema2({ fuel: { ...FUEL, received: undefined } }) as never)
		await runDepositClaim(word("02"))
		expect(sdk.calls).toHaveLength(0)
		expect(useBridgeJournal().runtime.value[word("02")]).toMatchObject({
			attention: "error",
			note: FEE_STOP_COPY["record-predates-send"],
		})
	})

	it("a deposit discovery moved while the claim was being set up restarts the claim on the new leaf", async () => {
		let open: () => void = () => {}
		const gate = new Promise<void>((r) => {
			open = r
		})
		sdk.deps.claimContext.mockImplementationOnce(async () => {
			await gate
			return { reads: {} as never, aztec: {} as never, network: async () => FAKE_NETWORK }
		})
		sdk.script(
			"token",
			async (c) => {
				await c.hold()
				throw new Error("the stale call was never stopped")
			},
			sendsClaim,
		)
		addRecord(schema4() as never)
		const run = runDepositClaim(word("04"))
		await vi.waitFor(() => expect(sdk.deps.claimContext).toHaveBeenCalled())
		updateCrossChainRecord(word("04"), { leafIndex: "9", messageHash: word("9f") })
		open()
		await run
		await vi.waitFor(() => expect(sdk.calls.map((c) => c.view.leafIndex)).toEqual(["7", "9"]))
	})

	it("a retired record of any shape resumes nothing", async () => {
		for (const make of [schema2, schema3, schema4]) addRecord(make({ claimTxHash: CLAIM, completedAt: 5 }) as never)
		resumeSessionWork()
		await new Promise((r) => setTimeout(r, 10))
		expect(sdk.deps.claimContext).not.toHaveBeenCalled()
	})
})
