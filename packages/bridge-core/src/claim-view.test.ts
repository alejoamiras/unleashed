import type { DepositRecord } from "@unleashed/sdk"
import { describe, expect, it } from "vitest"
import { claimView } from "./claim-view"
import {
	type AnyJournalRecord,
	type CrossChainDepositRecord,
	type DepositJournalRecord,
	type KV,
	RecordDeltaRefused,
	isRetirable,
	loadAllRecords,
	patchRecordDelta,
	patchRecordWhen,
	removeRecord,
	upsertRecord,
} from "./journal"
import { crossChainRecord, word } from "./test/crosschain-record"

function memKV(): KV {
	const store = new Map<string, string>()
	return { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, v), removeItem: (k) => void store.delete(k) }
}

const FUEL = { amount: "250", secret: word("f0"), secretHashHex: word("fe"), minOutput: "450", leafIndex: "8", messageHash: word("8e") }

const sendRecord = (): AnyJournalRecord =>
	({
		...crossChainRecord({ id: word("53"), secretHashHex: word("53"), leafIndex: "7", messageHash: word("7e"), fuel: FUEL }),
		schema: 3,
		route: undefined,
	}) as unknown as AnyJournalRecord

const crossChain = (): AnyJournalRecord => crossChainRecord({ leafIndex: "7", messageHash: word("7e"), fuel: FUEL })

const legacyFeeJuice = (): DepositJournalRecord => ({
	schema: 2,
	id: word("fe"),
	direction: "deposit",
	assetKind: "fee-juice",
	isPrivate: false,
	amount: "250",
	createdAt: 1,
	updatedAt: 1,
	chainId: 11155111,
	portal: `0x${"a2".repeat(20)}`,
	bridge: word("05"),
	recipient: word("10"),
	secretHashHex: word("fe"),
	leafIndex: "8",
	fuel: FUEL,
})

function stored(kv: KV, rec: AnyJournalRecord): AnyJournalRecord {
	upsertRecord(kv, rec)
	const found = loadAllRecords(kv).find((r) => r.id === rec.id)
	if (!found) throw new Error("fixture did not validate")
	return found
}

/** The view a claim starts from, and the record it hands back after latching its gas claim and sending its claim. */
function claimStep(rec: AnyJournalRecord): { base: DepositRecord; next: DepositRecord } {
	const base = claimView(rec) as DepositRecord
	const fuel = { ...(base.fuel as NonNullable<DepositRecord["fuel"]>), claimAttempt: true, claimAttemptAt: 5 }
	return { base, next: { ...base, claimTxHash: word("c7"), claimAttempt: true, claimAttemptAt: 5, fuel } }
}

describe("claimView", () => {
	it("reads schema 3 as stored, schema 4 without its route, a schema-2 Fee Juice deposit as gas only, nothing else", () => {
		expect(claimView(sendRecord())).toEqual(sendRecord())
		const { route: _route, ...rest } = crossChain() as { route: unknown }
		expect(claimView(crossChain())).toEqual({ ...rest, schema: 3 })
		const { assetKind: _kind, ...legacy } = legacyFeeJuice()
		expect(claimView(legacyFeeJuice())).toEqual({ ...legacy, schema: 3, intent: "gas" })
		expect(claimView({ ...legacyFeeJuice(), assetKind: "bridge-token" })).toBeUndefined()
		expect(claimView({ ...legacyFeeJuice(), schema: 1, fuel: undefined })).toBeUndefined()
	})
})

describe("patchRecordDelta", () => {
	it.each([
		["schema 2", legacyFeeJuice],
		["schema 3", sendRecord],
		["schema 4", crossChain],
	])("writes a claim's first persist onto a %s record in its own shape", (_name, make) => {
		const kv = memKV()
		const before = stored(kv, make())
		const { base, next } = claimStep(before)
		patchRecordDelta(kv, before.id, base, next)
		const after = loadAllRecords(kv).find((r) => r.id === before.id) as Record<string, unknown>
		expect(after).toMatchObject({ claimTxHash: word("c7"), claimAttempt: true, fuel: { ...FUEL, claimAttempt: true } })
		const kept = ["schema", "assetKind", "intent", "route", "sealedEnvelope", "sealerL1"] as const
		for (const k of kept) expect(after[k]).toEqual((before as unknown as Record<string, unknown>)[k])
	})

	it("refuses a field another writer moved, and writes one already holding next's value", () => {
		const kv = memKV()
		const rec = stored(kv, sendRecord())
		const { base, next } = claimStep(rec)
		patchRecordWhen(kv, rec.id, () => true, { claimTxHash: word("99") })
		expect(() => patchRecordDelta(kv, rec.id, base, next)).toThrow(RecordDeltaRefused)
		expect(loadAllRecords(kv)[0]).toMatchObject({ claimTxHash: word("99") })
		expect(loadAllRecords(kv)[0]).not.toHaveProperty("claimAttempt")

		patchRecordWhen(kv, rec.id, () => true, { claimTxHash: word("c7") })
		patchRecordDelta(kv, rec.id, base, next)
		expect(loadAllRecords(kv)[0]).toMatchObject({ claimTxHash: word("c7"), claimAttempt: true })
	})

	it("refuses a record whose claim identity moved, or that is gone, and writes nothing", () => {
		const kv = memKV()
		const rec = stored(kv, crossChain())
		const { base, next } = claimStep(rec)
		patchRecordWhen<AnyJournalRecord>(kv, rec.id, () => true, { leafIndex: "9" })
		expect(() => patchRecordDelta(kv, rec.id, base, next)).toThrow(expect.objectContaining({ reason: "identity" }))
		patchRecordWhen<AnyJournalRecord>(kv, rec.id, () => true, { fuel: { ...FUEL, leafIndex: "9" }, leafIndex: "7" })
		expect(() => patchRecordDelta(kv, rec.id, base, next)).toThrow(expect.objectContaining({ reason: "identity" }))
		expect(loadAllRecords(kv)[0]).not.toHaveProperty("claimTxHash")

		removeRecord(kv, rec.id)
		expect(() => patchRecordDelta(kv, rec.id, base, next)).toThrow(expect.objectContaining({ reason: "missing" }))
		expect(loadAllRecords(kv)).toEqual([])
	})

	it("keeps another writer's fields, in the record and inside its blocks, and deletes a field the claim cleared", () => {
		const kv = memKV()
		const rec = stored(kv, { ...crossChain(), claimTxHash: word("d1") } as AnyJournalRecord)
		const base = claimView(rec) as DepositRecord
		patchRecordWhen<CrossChainDepositRecord>(
			kv,
			rec.id,
			() => true,
			(cur) => ({
				depositL2Block: 42,
				fuel: { ...FUEL, ...cur.fuel, consumed: true },
				route: { ...cur.route, depositFinal: true },
			}),
		)
		const next = { ...base, claimTxHash: undefined, fuel: { ...(base.fuel as typeof FUEL), claimTxHash: word("d2") } }
		patchRecordDelta(kv, rec.id, base, next)
		const after = loadAllRecords(kv)[0] as Record<string, unknown>
		expect("claimTxHash" in after).toBe(false)
		expect(after).toMatchObject({
			depositL2Block: 42,
			fuel: { consumed: true, claimTxHash: word("d2") },
			route: { depositFinal: true },
		})
		expect(after.sealedEnvelope).toBe("c2VhbGVk")
	})
})

describe("retirement", () => {
	it("prunes by the SDK's rule, keeping a cross-chain record's outcome rule on top", () => {
		expect(isRetirable({ ...sendRecord(), completedAt: 3 } as AnyJournalRecord)).toBe(true)
		expect([isRetirable({ ...legacyFeeJuice(), completedAt: 3 }), isRetirable(legacyFeeJuice())]).toEqual([true, false])
		expect(isRetirable(sendRecord())).toBe(false)
		expect(isRetirable({ ...crossChain(), completedAt: 3 } as AnyJournalRecord)).toBe(true)
		const outcome = crossChainRecord({ leafIndex: "7", completedAt: 3 }, { outcome: "delivered-to-wallet" })
		expect(isRetirable(outcome)).toBe(false)
	})
})
