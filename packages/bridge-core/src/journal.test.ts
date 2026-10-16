import { describe, expect, it } from "vitest"
import {
	type AnyJournalRecord,
	type BridgeJournalRecord,
	type CrossChainDepositRecord,
	type CrossChainRoute,
	type DepositJournalRecord,
	type KV,
	type OutcomeObservation,
	type WithdrawJournalRecord,
	CROSSCHAIN_JOURNAL_KEY,
	CROSSCHAIN_QUARANTINE_KEY,
	JOURNAL_KEY,
	MAX_RECORDS,
	QUARANTINE_KEY,
	assetKindOf,
	capRecords,
	deriveCrossChainDepositStage,
	deriveDepositStage,
	deriveWithdrawStage,
	loadAllRecords,
	loadCrossChainJournal,
	loadJournal,
	loadQuarantine,
	makeProvisionalDepositId,
	makeProvisionalWithdrawId,
	outcomeFinality,
	outcomePatch,
	patchRecord,
	patchRecordWhen,
	pruneCompleted,
	quarantineInvalid,
	rekeyRecord,
	rekeyRecordWhen,
	removeRecord,
	upsertRecord,
} from "./journal"
import { SOURCE_CHAIN, crossChainRecord, word } from "./test/crosschain-record"

function memKV(initial: Record<string, string> = {}): KV & { store: Map<string, string> } {
	const store = new Map(Object.entries(initial))
	return {
		store,
		getItem: (k) => store.get(k) ?? null,
		setItem: (k, v) => void store.set(k, v),
		removeItem: (k) => void store.delete(k),
	}
}

const DEPLOY = { chainId: 11155111, portal: "0xportal", bridge: "0xbridge" }

function deposit(id: string, over: Partial<DepositJournalRecord> = {}): DepositJournalRecord {
	return {
		schema: 1,
		id,
		direction: "deposit",
		isPrivate: false,
		amount: "100",
		createdAt: 1,
		updatedAt: 1,
		recipient: "0xaztec",
		secretHashHex: id,
		...DEPLOY,
		...over,
	}
}

function withdraw(id: string, over: Partial<WithdrawJournalRecord> = {}): WithdrawJournalRecord {
	return {
		schema: 1,
		id,
		direction: "withdraw",
		isPrivate: false,
		amount: "40",
		createdAt: 1,
		updatedAt: 1,
		recipientL1: "0xeth",
		exitTxHash: id,
		...DEPLOY,
		...over,
	}
}

const ERC20 = "0x70e0ba845a1a0f2da3359c97e0285013525ffc49"
const CLONE = "0x94752ef7cf8f037f78ee7722a9387ef95c819fc8"

const TOKEN_BLOCK = {
	erc20: ERC20,
	portal: CLONE,
	l2Token: `0x${"c".repeat(64)}`,
	nameWord: `0x${"1".repeat(64)}`,
	symbolWord: `0x${"2".repeat(64)}`,
	decimals: 6,
	displaySymbol: "USDC",
	registerKey: `0x${"4".repeat(64)}`,
	registerIndex: "3",
}

function sendDeposit(id: string, over: Record<string, unknown> = {}) {
	return {
		schema: 3,
		id,
		direction: "deposit",
		isPrivate: false,
		intent: "token",
		token: TOKEN_BLOCK,
		amount: "100",
		createdAt: 1,
		updatedAt: 1,
		chainId: 11155111,
		portal: CLONE,
		bridge: `0x${"b".repeat(64)}`,
		recipient: "0xaztec",
		secretHashHex: id,
		...over,
	}
}

describe("journal CRUD", () => {
	it("upserts multiple records and patches one without touching the others", () => {
		const kv = memKV()
		upsertRecord(kv, deposit("0xaaa"))
		upsertRecord(kv, deposit("0xbbb"))
		patchRecord(kv, "0xaaa", { leafIndex: "42" })
		const records = loadJournal(kv)
		expect(records).toHaveLength(2)
		expect((records.find((r) => r.id === "0xaaa") as DepositJournalRecord).leafIndex).toBe("42")
		expect((records.find((r) => r.id === "0xbbb") as DepositJournalRecord).leafIndex).toBeUndefined()
	})

	it("upsert replaces by id instead of duplicating", () => {
		const kv = memKV()
		upsertRecord(kv, deposit("0xaaa"))
		upsertRecord(kv, deposit("0xaaa", { amount: "999" }))
		const records = loadJournal(kv)
		expect(records).toHaveLength(1)
		expect(records[0].amount).toBe("999")
	})

	it("patch on a missing id is a no-op", () => {
		const kv = memKV()
		upsertRecord(kv, deposit("0xaaa"))
		expect(patchRecord(kv, "0xnope", { leafIndex: "1" })).toBeUndefined()
		expect(loadJournal(kv)).toHaveLength(1)
	})

	it("a guarded patch applies only while the freshly loaded record satisfies the guard", () => {
		const kv = memKV()
		upsertRecord(kv, deposit("0xaaa", { claimTxHash: "0xH" }))
		const rejected = patchRecordWhen(kv, "0xaaa", (cur) => (cur as DepositJournalRecord).claimTxHash === "0xstale", {
			claimTxHash: undefined,
		})
		expect(rejected).toBeUndefined()
		expect((loadJournal(kv)[0] as DepositJournalRecord).claimTxHash).toBe("0xH")
		const applied = patchRecordWhen(kv, "0xaaa", (cur) => (cur as DepositJournalRecord).claimTxHash === "0xH", {
			claimTxHash: undefined,
		})
		expect((applied as DepositJournalRecord).claimTxHash).toBeUndefined()
		expect((loadJournal(kv)[0] as DepositJournalRecord).claimTxHash).toBeUndefined()
		expect(patchRecordWhen(kv, "0xnope", () => true, { leafIndex: "1" })).toBeUndefined()
		// A functional patch reads the record the guard accepted, not a copy taken earlier.
		const merged = patchRecordWhen(
			kv,
			"0xaaa",
			() => true,
			(cur) => ({ leafIndex: `${cur.id}-leaf` }),
		)
		expect(merged).toMatchObject({ leafIndex: "0xaaa-leaf" })
	})

	it("rekey upgrades a provisional withdraw to its exitTxHash id", () => {
		const kv = memKV()
		upsertRecord(kv, withdraw("wd-pending-x", { exitTxHash: undefined }))
		rekeyRecord(kv, "wd-pending-x", withdraw("0xexit1"))
		const records = loadJournal(kv)
		expect(records).toHaveLength(1)
		expect(records[0].id).toBe("0xexit1")
	})

	it("rekeyRecordWhen re-keys only a source that passes its guard and only onto a free id", () => {
		const kv = memKV()
		upsertRecord(kv, withdraw("wd-pending-x", { exitTxHash: undefined }))
		// The guard sees the live source and the whole journal.
		expect(rekeyRecordWhen(kv, "wd-pending-x", (cur) => !!(cur as WithdrawJournalRecord).exitTxHash, withdraw("0xexit1"))).toBe(false)
		expect(loadJournal(kv).map((r) => r.id)).toEqual(["wd-pending-x"])
		expect(rekeyRecordWhen(kv, "wd-pending-x", (cur, all) => all.length === 1 && !cur.completedAt, withdraw("0xexit1"))).toBe(true)
		expect(loadJournal(kv).map((r) => r.id)).toEqual(["0xexit1"])
		// A destination already held by another record is never overwritten.
		upsertRecord(kv, withdraw("wd-pending-y", { exitTxHash: undefined }))
		expect(rekeyRecordWhen(kv, "wd-pending-y", () => true, withdraw("0xexit1"))).toBe(false)
		expect(
			loadJournal(kv)
				.map((r) => r.id)
				.sort(),
		).toEqual(["0xexit1", "wd-pending-y"])
		// A vanished source is a no-op.
		expect(rekeyRecordWhen(kv, "gone", () => true, withdraw("0xexit2"))).toBe(false)
	})

	it("remove deletes only the targeted record", () => {
		const kv = memKV()
		upsertRecord(kv, deposit("0xaaa"))
		upsertRecord(kv, withdraw("0xexit"))
		removeRecord(kv, "0xaaa")
		expect(loadJournal(kv).map((r) => r.id)).toEqual(["0xexit"])
	})
})

describe("schema-2 fuel records", () => {
	const fuel = {
		amount: "250000000000000000",
		secret: "0xf00d",
		secretHashHex: "0xfeed",
		minOutput: "450000000000000000000",
	}

	it("a fueled deposit round-trips through the journal with its fuel block intact", () => {
		const kv = memKV()
		upsertRecord(kv, deposit("0xfueled", { schema: 2, fuel }))
		const [rec] = loadJournal(kv) as DepositJournalRecord[]
		expect(rec.schema).toBe(2)
		expect(rec.fuel).toEqual(fuel)
	})

	it("schema-1 and schema-2 records coexist in one journal; schema-1 loads byte-identically", () => {
		const kv = memKV()
		const schema1 = deposit("0xschema1")
		upsertRecord(kv, schema1)
		upsertRecord(kv, deposit("0xfueled", { schema: 2, fuel }))
		const records = loadJournal(kv)
		expect(records).toHaveLength(2)
		// upsert stamps updatedAt; every OTHER field of the schema-1 record is untouched.
		const { updatedAt: _, ...loaded } = records.find((r) => r.id === "0xschema1") as DepositJournalRecord
		const { updatedAt: __, ...expected } = schema1
		expect(loaded).toEqual(expected)
	})

	it("updating fuel progress (received/claimAttempt/consumed) persists via updateRecord", () => {
		const kv = memKV()
		upsertRecord(kv, deposit("0xfueled", { schema: 2, fuel }))
		patchRecord(kv, "0xfueled", {
			fuel: { ...fuel, leafIndex: "7", received: "487000000000000000000", claimAttempt: true, consumed: true },
		} as Partial<DepositJournalRecord>)
		const [rec] = loadJournal(kv) as DepositJournalRecord[]
		expect(rec.fuel?.received).toBe("487000000000000000000")
		expect(rec.fuel?.claimAttempt).toBe(true)
		expect(rec.fuel?.consumed).toBe(true)
	})
})

describe("assetKind (Fuel variant)", () => {
	it("defaults to bridge-token when absent; reads fee-juice when set; withdraws are always token", () => {
		expect(assetKindOf(deposit("0xtoken"))).toBe("bridge-token")
		expect(assetKindOf(deposit("0xfuel", { assetKind: "fee-juice" }))).toBe("fee-juice")
		expect(assetKindOf(withdraw("0xexit"))).toBe("bridge-token")
	})

	it("a fee-juice deposit round-trips through the journal with its variant + binding intact", () => {
		const kv = memKV()
		upsertRecord(kv, deposit("0xfj", { assetKind: "fee-juice", portal: "0xfjportal", bridge: "0xfjL2" }))
		const [rec] = loadJournal(kv) as DepositJournalRecord[]
		expect(assetKindOf(rec)).toBe("fee-juice")
		expect(rec.portal).toBe("0xfjportal")
	})

	it("REGRESSION: a pre-Fuel journal (no assetKind) loads EVERY record, each as bridge-token (additive)", () => {
		const kv = memKV({
			[JOURNAL_KEY]: JSON.stringify({
				schema: 1,
				records: [
					deposit("0xa"),
					deposit("0xb", { schema: 2, fuel: { amount: "1", secret: "0x1", secretHashHex: "0x2", minOutput: "3" } }),
					withdraw("0xc"),
				],
			}),
		})
		const records = loadJournal(kv)
		expect(records.map((r) => r.id).sort()).toEqual(["0xa", "0xb", "0xc"])
		for (const r of records) expect(assetKindOf(r)).toBe("bridge-token")
	})
})

describe("multi-tab safety (per-record merge)", () => {
	it("a writer with a stale in-memory snapshot cannot erase a record another writer just added", () => {
		const kv = memKV()
		// Tab A creates record A. Tab B, which read the journal BEFORE A existed (stale snapshot),
		// now writes record B — upsert re-reads at write time, so A must survive.
		upsertRecord(kv, deposit("0xfromA"))
		upsertRecord(kv, deposit("0xfromB"))
		expect(
			loadJournal(kv)
				.map((r) => r.id)
				.sort(),
		).toEqual(["0xfromA", "0xfromB"])
	})
})

describe("parse hardening + cap priority", () => {
	it("corrupt JSON yields an empty journal, never a crash", () => {
		const kv = memKV({ [JOURNAL_KEY]: "{not json" })
		expect(loadJournal(kv)).toEqual([])
	})

	it("wrong schema or non-array records yields empty", () => {
		const kv = memKV({ [JOURNAL_KEY]: JSON.stringify({ schema: 2, records: [deposit("0xa")] }) })
		expect(loadJournal(kv)).toEqual([])
	})

	it("garbage entries inside the array are dropped", () => {
		const kv = memKV({
			[JOURNAL_KEY]: JSON.stringify({ schema: 1, records: [deposit("0xa"), null, 7, { direction: "deposit" }] }),
		})
		expect(loadJournal(kv).map((r) => r.id)).toEqual(["0xa"])
	})

	it("a COMPLETED-junk flood never evicts an unfinished record (prioritized retention)", () => {
		const live = deposit("0xlive", { updatedAt: 5 })
		const junk: BridgeJournalRecord[] = Array.from({ length: MAX_RECORDS + 50 }, (_, i) =>
			deposit(`0xjunk${i}`, { completedAt: 1000 + i, updatedAt: 1000 + i }),
		)
		const capped = capRecords([...junk, live])
		expect(capped.some((r) => r.id === "0xlive")).toBe(true)
		// The evicted ones are the OLDEST completed.
		expect(capped.some((r) => r.id === "0xjunk0")).toBe(false)
	})

	it("an UNFINISHED-junk flood cannot evict a live record either — unfinished records are never dropped", () => {
		const live = deposit("0xlive", { updatedAt: 1 }) // oldest of all
		const junk: BridgeJournalRecord[] = Array.from({ length: MAX_RECORDS + 50 }, (_, i) =>
			deposit(`0xjunk${i}`, { updatedAt: 1000 + i }),
		)
		const capped = capRecords([...junk, live])
		expect(capped.some((r) => r.id === "0xlive")).toBe(true)
		expect(capped.filter((r) => !r.completedAt)).toHaveLength(MAX_RECORDS + 51)
	})
})

describe("load-time deep validation + quarantine", () => {
	it("a schema-3 record with no token block never loads, and the load survives it", () => {
		const broken = { schema: 3, id: "0xbroken", direction: "deposit", intent: "token" }
		const kv = memKV({ [JOURNAL_KEY]: JSON.stringify({ schema: 1, records: [broken, sendDeposit("0xgood")] }) })
		expect(loadJournal(kv).map((r) => r.id)).toEqual(["0xgood"])
	})

	it("a valid schema-3 record loads with its token block intact - the pin source is what passed", () => {
		const kv = memKV({ [JOURNAL_KEY]: JSON.stringify({ schema: 1, records: [sendDeposit("0xgood")] }) })
		const [rec] = loadJournal(kv)
		expect(rec.schema).toBe(3)
		expect((rec as { token?: { l2Token: string } }).token?.l2Token).toBe(TOKEN_BLOCK.l2Token)
	})

	it("attacker-shaped words are refused: a token block whose nameWord is not a field is quarantined", () => {
		const forged = sendDeposit("0xforged", { token: { ...TOKEN_BLOCK, nameWord: "javascript:alert(1)" } })
		const kv = memKV({ [JOURNAL_KEY]: JSON.stringify({ schema: 1, records: [forged] }) })
		expect(loadJournal(kv)).toEqual([])
	})

	it("a stored record whose sender is not a string is quarantined; a record without one loads", () => {
		const forged = sendDeposit("0xforged", { sender: 7 })
		const kv = memKV({ [JOURNAL_KEY]: JSON.stringify({ schema: 1, records: [forged, sendDeposit("0xpre")] }) })
		expect(quarantineInvalid(kv)).toBe(1)
		expect(loadQuarantine(kv)).toEqual([forged])
		expect(loadJournal(kv).map((r) => r.id)).toEqual(["0xpre"])
	})

	it("quarantineInvalid parks the bad entries and rewrites the journal without them - never a silent drop", () => {
		const broken = { schema: 3, id: "0xbroken", direction: "deposit", intent: "token" }
		const kv = memKV({ [JOURNAL_KEY]: JSON.stringify({ schema: 1, records: [broken, sendDeposit("0xgood")] }) })
		expect(quarantineInvalid(kv)).toBe(1)
		expect(loadQuarantine(kv)).toEqual([broken])
		expect(kv.store.has(QUARANTINE_KEY)).toBe(true)
		expect(JSON.parse(kv.store.get(JOURNAL_KEY) as string).records.map((r: { id: string }) => r.id)).toEqual(["0xgood"])
		// Idempotent: a second sweep has nothing left to move.
		expect(quarantineInvalid(kv)).toBe(0)
		expect(loadQuarantine(kv)).toHaveLength(1)
	})

	it("a half-started row survives the sweep - it is the app's own, not a recovery file", () => {
		const pending = makeProvisionalWithdrawId()
		const kv = memKV({
			[JOURNAL_KEY]: JSON.stringify({
				schema: 1,
				records: [{ ...sendDeposit(pending), direction: "withdraw", recipientL1: "0xeth", intent: "token" }],
			}),
		})
		expect(loadJournal(kv).map((r) => r.id)).toEqual([pending])
		expect(quarantineInvalid(kv)).toBe(0)
	})
})

describe("prune", () => {
	it("pruneCompleted drops only old completed records", () => {
		const kv = memKV()
		upsertRecord(kv, deposit("0xold", { completedAt: 1000 }))
		upsertRecord(kv, deposit("0xfresh", { completedAt: 9000 }))
		upsertRecord(kv, deposit("0xinflight"))
		pruneCompleted(kv, 5000, 10_000)
		expect(
			loadJournal(kv)
				.map((r) => r.id)
				.sort(),
		).toEqual(["0xfresh", "0xinflight"])
	})
})

describe("stage derivation (never persisted)", () => {
	it("deposit milestone table", () => {
		expect(deriveDepositStage(deposit("a"))).toBe("depositing")
		expect(deriveDepositStage(deposit("a", { depositTxHash: "0xd" }))).toBe("depositing")
		expect(deriveDepositStage(deposit("a", { leafIndex: "7" }))).toBe("syncing")
		expect(deriveDepositStage(deposit("a", { leafIndex: "7" }), { claimable: true })).toBe("claimable")
		expect(deriveDepositStage(deposit("a", { leafIndex: "7", claimTxHash: "0xc" }))).toBe("claiming")
		expect(deriveDepositStage(deposit("a", { leafIndex: "7", claimTxHash: "0xc", completedAt: 1 }))).toBe("done")
	})

	it("withdraw milestone table", () => {
		expect(deriveWithdrawStage(withdraw("a", { exitTxHash: undefined }))).toBe("exiting")
		expect(deriveWithdrawStage(withdraw("a"))).toBe("proving")
		expect(deriveWithdrawStage(withdraw("a"), { proven: true })).toBe("consumable")
		expect(deriveWithdrawStage(withdraw("a", { consumeTxHash: "0xc" }))).toBe("consuming")
		expect(deriveWithdrawStage(withdraw("a", { consumeTxHash: "0xc", completedAt: 1 }))).toBe("done")
	})
})

const ids = (records: AnyJournalRecord[]) => records.map((r) => r.id)

describe("cross-chain records (schema 4, their own storage key)", () => {
	it("old-tab sequence: today's JOURNAL_KEY writes leave the stored cross-chain records byte-identical", () => {
		const kv = memKV()
		upsertRecord(kv, crossChainRecord())
		upsertRecord(kv, crossChainRecord({ id: word("c2"), secretHashHex: word("c2") }))
		const stored = kv.store.get(CROSSCHAIN_JOURNAL_KEY)
		const written = new Set<string>()
		const tab: KV = {
			...kv,
			setItem: (k, v) => {
				written.add(k)
				kv.setItem(k, v)
			},
		}
		upsertRecord(tab, deposit("0xaaa"))
		patchRecord(tab, "0xaaa", { leafIndex: "42" })
		upsertRecord(tab, withdraw("wd-pending-x", { exitTxHash: undefined }))
		rekeyRecord(tab, "wd-pending-x", withdraw("0xexit"))
		const legacy = JSON.parse(kv.store.get(JOURNAL_KEY) as string)
		kv.setItem(JOURNAL_KEY, JSON.stringify({ ...legacy, records: [...legacy.records, { id: "0xjunk" }] }))
		expect(quarantineInvalid(tab)).toBe(1)
		removeRecord(tab, "0xaaa")
		pruneCompleted(tab, 0, Number.MAX_SAFE_INTEGER)
		expect(written).toEqual(new Set([JOURNAL_KEY, QUARANTINE_KEY]))
		expect(kv.store.get(CROSSCHAIN_JOURNAL_KEY)).toBe(stored)
		expect(ids(loadJournal(kv))).toEqual(["0xexit"])
		expect(ids(loadCrossChainJournal(kv))).toEqual([word("c1"), word("c2")])
	})

	it("routes each mutation to the key that holds the record, and an id lives under one key", () => {
		const kv = memKV()
		const pending = makeProvisionalDepositId()
		upsertRecord(kv, crossChainRecord({ id: pending }))
		expect(kv.store.has(JOURNAL_KEY)).toBe(false)
		rekeyRecord(kv, pending, crossChainRecord())
		const patched = patchRecordWhen<CrossChainDepositRecord>(
			kv,
			word("c1"),
			(cur) => cur.route.transport?.kind === "across",
			(cur) => ({ route: { ...cur.route, srcTxHash: word("58") } }),
		)
		expect(patched?.route.srcTxHash).toBe(word("58"))
		const before = kv.store.get(CROSSCHAIN_JOURNAL_KEY)
		// A patch that would move the record to the other key is a no-op; a malformed one throws.
		expect(patchRecord(kv, word("c1"), { schema: 3 })).toBeUndefined()
		expect(() =>
			patchRecord<CrossChainDepositRecord>(kv, word("c1"), { route: { ...crossChainRecord().route, maxPull: "1" } }),
		).toThrow(/malformed/)
		expect(() => upsertRecord(kv, deposit(word("c1")))).toThrow(/other journal key/)
		expect(kv.store.get(CROSSCHAIN_JOURNAL_KEY)).toBe(before)
		upsertRecord(kv, deposit("0xeth"))
		expect(ids(loadAllRecords(kv))).toEqual(["0xeth", word("c1")])
		// A schema-4 entry under JOURNAL_KEY is never a record there: the sweep parks it.
		const misplaced = crossChainRecord({ id: word("c9"), secretHashHex: word("c9") })
		kv.setItem(JOURNAL_KEY, JSON.stringify({ schema: 1, records: [deposit("0xeth"), misplaced] }))
		expect(ids(loadJournal(kv))).toEqual(["0xeth"])
		kv.setItem(
			CROSSCHAIN_JOURNAL_KEY,
			JSON.stringify({ schema: 1, records: [...JSON.parse(before as string).records, { id: "0xjunk" }] }),
		)
		expect(quarantineInvalid(kv)).toBe(2)
		expect(JSON.parse(kv.store.get(CROSSCHAIN_QUARANTINE_KEY) as string).records).toEqual([{ id: "0xjunk" }])
		expect(loadQuarantine(kv)).toEqual([misplaced, { id: "0xjunk" }])
		removeRecord(kv, word("c1"))
		expect(loadCrossChainJournal(kv)).toEqual([])
	})

	it("stages: depositing → bridging → syncing, then the Ethereum-origin rail", () => {
		expect(deriveCrossChainDepositStage(crossChainRecord({}, { srcTxHash: undefined }))).toBe("depositing")
		expect(deriveCrossChainDepositStage(crossChainRecord({}, { srcTxHash: undefined, srcBatchId: "batch" }))).toBe("bridging")
		expect(deriveCrossChainDepositStage(crossChainRecord())).toBe("bridging")
		expect(deriveCrossChainDepositStage(crossChainRecord({ leafIndex: "7" }))).toBe("syncing")
		expect(deriveCrossChainDepositStage(crossChainRecord({ leafIndex: "7" }), { claimable: true })).toBe("claimable")
		expect(deriveCrossChainDepositStage(crossChainRecord({ leafIndex: "7", claimTxHash: "0xc", completedAt: 2 }))).toBe("done")
	})

	it("an outcome before its deciding block is finalized stays provisional and never sets completedAt", () => {
		const rec = crossChainRecord()
		const eth = (blockNumber: bigint) => ({ chainId: rec.chainId, blockNumber })
		const src = (blockNumber: bigint) => ({ chainId: SOURCE_CHAIN, blockNumber })
		const seen: OutcomeObservation = {
			outcome: "delivered-to-wallet",
			txHash: word("de"),
			amount: "100000000",
			decidedAt: eth(100n),
			finalized: eth(99n),
		}
		const kv = memKV()
		upsertRecord(kv, rec)
		const observe = (obs: OutcomeObservation, now: number) =>
			patchRecordWhen<CrossChainDepositRecord>(
				kv,
				rec.id,
				(cur) => outcomeFinality(cur) !== "final",
				(cur) => outcomePatch(cur, obs, now),
			)
		const provisional = observe(seen, 5) as CrossChainDepositRecord
		expect(provisional.completedAt).toBeUndefined()
		expect(outcomeFinality(provisional)).toBe("provisional")
		expect(deriveCrossChainDepositStage(provisional)).toBe("delivered-to-wallet")
		const final = observe({ ...seen, finalized: eth(100n) }, 7) as CrossChainDepositRecord
		expect([final.completedAt, outcomeFinality(final)]).toEqual([7, "final"])
		expect(observe({ ...seen, outcome: "expired-on-source", finalized: eth(200n) }, 9)).toBeUndefined()
		expect(() => outcomePatch(final, { ...seen, finalized: eth(200n) }, 9)).toThrow(/final/)
		// Heights settle only on the chain that decides the outcome: the source chain for not-sent.
		expect(() => outcomePatch(rec, { ...seen, outcome: "not-sent" }, 5)).toThrow(`chain ${SOURCE_CHAIN}`)
		expect(() => outcomePatch(rec, { ...seen, finalized: src(1_000n) }, 5)).toThrow(`chain ${rec.chainId}`)
		expect(outcomePatch(rec, { outcome: "not-sent", decidedAt: src(5n), finalized: src(5n) }, 9).completedAt).toBe(9)
	})

	it("only a deposited-and-claimed record with no extra is ever pruned or evicted", () => {
		const claimed = (id: string, completedAt = 1000, route: Partial<CrossChainRoute> = {}) =>
			crossChainRecord({ id, secretHashHex: id, leafIndex: "7", claimTxHash: word("cc"), completedAt }, route)
		const kept = [
			crossChainRecord({ id: word("d1"), secretHashHex: word("d1"), completedAt: 1000 }, { outcome: "delivered-to-wallet" }),
			crossChainRecord({ id: word("d2"), secretHashHex: word("d2"), completedAt: 1000 }, { outcome: "expired-on-source" }),
			crossChainRecord({ id: word("d3"), secretHashHex: word("d3"), completedAt: 1000 }, { outcome: "not-sent" }),
			claimed(word("d4"), 1000, { extraDeposits: [{ txHash: word("ee"), leafIndex: "8", amount: "5" }] }),
		]
		const kv = memKV()
		for (const r of [...kept, claimed(word("d5"))]) upsertRecord(kv, r)
		pruneCompleted(kv, 1, 10_000)
		expect(ids(loadCrossChainJournal(kv))).toEqual(ids(kept))
		const flood = Array.from({ length: MAX_RECORDS + 10 }, (_, i) => claimed(`0xflood${i}`, 2000 + i))
		const capped = capRecords([...flood, ...kept])
		expect(capped).toHaveLength(MAX_RECORDS)
		expect(ids(capped)).toEqual(expect.arrayContaining(ids(kept)))
	})
})
