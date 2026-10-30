/**
 * Field-level rejection table for `validateBackupRecord`, complementing `backup.test.ts` (which
 * covers the fuel-block contradictions, the assetKind/extras and the junk shapes). Pinned before the
 * validator is split per direction: EVERY mutation below must keep rejecting with the one message,
 * and the two fully-populated shapes must keep validating unchanged. The validator is strict on
 * SHAPE only (empty required strings pass, numbers are type-checked) — that acceptance set is part
 * of the pin, not something to tighten in passing.
 *
 * Below the table, byte pins: what a journal, a recovery file and a v2 envelope look like on disk.
 * The schema 1–3 digests and the sealed v2 blob were produced by the code that predates schema 4, so
 * an existing user's storage and files must keep loading and re-serializing to the same bytes.
 */

import { createHash } from "node:crypto"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
	type LegacyBridgeBackupFile,
	openAnyBridgeBackup,
	openBridgeBackup,
	parseBackupFile,
	sealBridgeBackup,
	validateAnyBackupRecord,
	validateBackupRecord,
	validateCrossChainRecord,
	validateJournalRecord,
} from "./backup"
import {
	type BridgeJournalRecord,
	type CrossChainDepositRecord,
	type DepositJournalRecord,
	type KV,
	type WithdrawJournalRecord,
	CROSSCHAIN_JOURNAL_KEY,
	JOURNAL_KEY,
	loadJournal,
	patchRecord,
	upsertRecord,
} from "./journal"
import { RecoveryKey, openDepositEnvelope, sealDepositEnvelope } from "./recovery-crypto"
import { crossChainRecord, stargateRecord, addr as A, word as H } from "./test/crosschain-record"

const REJECT = /not a valid bridge record/

const fuel = {
	amount: "250000000000000000",
	secret: "0xf00d",
	secretHashHex: "0xfeed",
	minOutput: "0",
	leafIndex: "7",
	received: "487000000000000000000",
	claimAttempt: true,
	claimTxHash: "0xclaim",
	consumed: false,
	standaloneClaimed: false,
	bridgeSecretSalt: "0x5a17",
	fpc: "0xfpc",
	setupInsufficiency: false,
}

const fullDeposit: DepositJournalRecord = {
	schema: 2,
	id: "0xdep",
	direction: "deposit",
	isPrivate: true,
	amount: "100000000",
	createdAt: 1,
	updatedAt: 2,
	completedAt: 3,
	chainId: 11155111,
	portal: "0xportal",
	bridge: "0xbridge",
	recipient: "0xrecipient",
	secretHashHex: "0xdep",
	secret: undefined,
	sealedEnvelope: "blob",
	sealerL1: "0xsealer",
	sender: "0xsender",
	depositTxHash: "0xtx",
	leafIndex: "7",
	claimTxHash: "0xclaim",
	depositL2Block: 42,
	assetKind: "fee-juice",
	fuel,
} as DepositJournalRecord

const fullWithdraw: WithdrawJournalRecord = {
	schema: 1,
	id: "0xexit",
	direction: "withdraw",
	isPrivate: false,
	amount: "40000000",
	createdAt: 1,
	updatedAt: 2,
	completedAt: 3,
	chainId: 11155111,
	portal: "0xportal",
	bridge: "0xbridge",
	recipientL1: "0xsealer",
	exitTxHash: "0xexit",
	exitBlock: 9,
	consumeTxHash: "0xconsume",
	sender: "0xaztecsender",
} as WithdrawJournalRecord

const mutate = (base: object, patch: Record<string, unknown>) => ({ ...base, ...patch })
const mutateFuel = (patch: Record<string, unknown>) => mutate(fullDeposit, { fuel: { ...fuel, ...patch } })

describe("validateBackupRecord — field-level rejection table", () => {
	it("accepts the fully-populated deposit and withdraw shapes unchanged (and empty required strings)", () => {
		expect(validateBackupRecord(fullDeposit)).toEqual(fullDeposit)
		expect(validateBackupRecord(fullWithdraw)).toEqual(fullWithdraw)
		const emptyStrings = mutate(fullDeposit, { portal: "", bridge: "", recipient: "", secretHashHex: "" })
		expect(validateBackupRecord(emptyStrings)).toEqual(emptyStrings)
	})

	it.each<[string, unknown]>([
		["null", null],
		["a string", "record"],
		["schema 3", mutate(fullDeposit, { schema: 3 })],
		["empty id", mutate(fullDeposit, { id: "" })],
		["numeric id", mutate(fullDeposit, { id: 7 })],
		["isPrivate string", mutate(fullDeposit, { isPrivate: "true" })],
		["amount with decimals", mutate(fullDeposit, { amount: "1.5" })],
		["amount number", mutate(fullDeposit, { amount: 100 })],
		["createdAt string", mutate(fullDeposit, { createdAt: "1" })],
		["updatedAt missing", mutate(fullDeposit, { updatedAt: undefined })],
		["completedAt string", mutate(fullDeposit, { completedAt: "3" })],
		["chainId string", mutate(fullDeposit, { chainId: "11155111" })],
		["portal missing", mutate(fullDeposit, { portal: undefined })],
		["bridge number", mutate(fullDeposit, { bridge: 1 })],
		["unknown direction", mutate(fullDeposit, { direction: "swap" })],
	])("common shape: %s rejects", (_label, rec) => {
		expect(() => validateBackupRecord(rec)).toThrow(REJECT)
	})

	it.each<[string, unknown]>([
		["recipient missing", mutate(fullDeposit, { recipient: undefined })],
		["secretHashHex number", mutate(fullDeposit, { secretHashHex: 1 })],
		["secret number", mutate(fullDeposit, { secret: 1 })],
		["sealedEnvelope object", mutate(fullDeposit, { sealedEnvelope: {} })],
		["sealerL1 number", mutate(fullDeposit, { sealerL1: 1 })],
		["sender number", mutate(fullDeposit, { sender: 1 })],
		["depositTxHash number", mutate(fullDeposit, { depositTxHash: 1 })],
		["leafIndex number", mutate(fullDeposit, { leafIndex: 7 })],
		["claimTxHash boolean", mutate(fullDeposit, { claimTxHash: true })],
		["depositL2Block string", mutate(fullDeposit, { depositL2Block: "42" })],
		["fuel null on schema 2", mutate(fullDeposit, { fuel: null })],
		["fuel amount missing", mutateFuel({ amount: undefined })],
		["fuel secret number", mutateFuel({ secret: 1 })],
		["fuel secretHashHex missing", mutateFuel({ secretHashHex: undefined })],
		["fuel minOutput missing", mutateFuel({ minOutput: undefined })],
		["fuel minOutput hex", mutateFuel({ minOutput: "0x10" })],
		["fuel leafIndex non-decimal", mutateFuel({ leafIndex: "7x" })],
		["fuel received non-decimal", mutateFuel({ received: "1e18" })],
		["fuel claimAttempt string", mutateFuel({ claimAttempt: "yes" })],
		["fuel claimTxHash number", mutateFuel({ claimTxHash: 1 })],
		["fuel consumed string", mutateFuel({ consumed: "no" })],
		["fuel standaloneClaimed number", mutateFuel({ standaloneClaimed: 0 })],
	])("deposit: %s rejects", (_label, rec) => {
		expect(() => validateBackupRecord(rec)).toThrow(REJECT)
	})

	it.each<[string, unknown]>([
		["recipientL1 number", mutate(fullWithdraw, { recipientL1: 1 })],
		["exitTxHash number", mutate(fullWithdraw, { exitTxHash: 1 })],
		["exitBlock string", mutate(fullWithdraw, { exitBlock: "9" })],
		["consumeTxHash boolean", mutate(fullWithdraw, { consumeTxHash: false })],
		["sender number", mutate(fullWithdraw, { sender: 1 })],
		["provisional (half-started) id", mutate(fullWithdraw, { id: "wd-pending-abc12345", exitTxHash: undefined })],
	])("withdraw: %s rejects", (_label, rec) => {
		expect(() => validateBackupRecord(rec)).toThrow(REJECT)
	})
})

const xc = crossChainRecord()
const sg = stargateRecord()
const mutateRoute = (patch: Record<string, unknown>, base: CrossChainDepositRecord = xc) => ({
	...base,
	route: { ...base.route, ...patch },
})
const across = xc.route.transport as object

describe("validateCrossChainRecord — schema 4", () => {
	it("accepts both rails fully populated, unchanged; the Ethereum-origin validator refuses them", () => {
		for (const rec of [xc, sg, mutateRoute({ terms: "fixed" }), { ...mutateRoute({ depositFinal: true }), leafIndex: "7" }]) {
			expect(validateCrossChainRecord(rec)).toEqual(rec)
			expect(validateJournalRecord(rec)).toEqual(rec)
			expect(() => validateAnyBackupRecord(rec)).toThrow(REJECT)
		}
		expect(() => validateCrossChainRecord(fullDeposit)).toThrow(REJECT)
	})

	it.each<[string, unknown]>([
		["route missing", { ...xc, route: undefined }],
		["a withdraw", { ...xc, direction: "withdraw" }],
		["shared: secretHashHex number", { ...xc, secretHashHex: 1 }],
		["shared: token block of another clone", { ...xc, token: { ...xc.token, portal: A("b1") } }],
		["provider other", mutateRoute({ provider: "socket" })],
		["rail unknown", mutateRoute({ rail: "cctp" })],
		["srcChainId string", mutateRoute({ srcChainId: "84532" })],
		["srcChainId zero", mutateRoute({ srcChainId: 0 })],
		["srcToken short", mutateRoute({ srcToken: "0xb5" })],
		["srcAmount decimal point", mutateRoute({ srcAmount: "1.5" })],
		["srcSender missing", mutateRoute({ srcSender: undefined })],
		["srcScanFromBlock number", mutateRoute({ srcScanFromBlock: 31000000 })],
		["srcBatchId empty", mutateRoute({ srcBatchId: "" })],
		["srcTxHash short", mutateRoute({ srcTxHash: "0x57" })],
		["lifiTxId missing", mutateRoute({ lifiTxId: undefined })],
		["router missing", mutateRoute({ router: undefined })],
		["minReceived above maxPull", mutateRoute({ minReceived: "100000001" })],
		["maxPull hex", mutateRoute({ maxPull: "0x10" })],
		["scanFromBlock missing", mutateRoute({ scanFromBlock: undefined })],
		["etaSeconds string", mutateRoute({ etaSeconds: "120" })],
		["etaSeconds negative", mutateRoute({ etaSeconds: -1 })],
		["fillDeadline string", mutateRoute({ fillDeadline: "1" })],
		["fillDeadline on Stargate", mutateRoute({ fillDeadline: 1 }, sg)],
		["terms unknown", mutateRoute({ terms: "quoted" })],
		["fixed terms on Stargate", mutateRoute({ terms: "fixed" }, sg)],
		["transport kind unknown", mutateRoute({ transport: { ...across, kind: "cctp" } })],
		["Across relayHash short", mutateRoute({ transport: { ...across, relayHash: "0x4e" } })],
		["Across depositId hex", mutateRoute({ transport: { ...across, depositId: "0x10" } })],
		["Across originChainId string", mutateRoute({ transport: { ...across, originChainId: "84532" } })],
		["Across transport on Stargate", mutateRoute({ transport: across }, sg)],
		["Stargate transport on Across", mutateRoute({ transport: sg.route.transport })],
		["Stargate pool short", mutateRoute({ transport: { ...(sg.route.transport as object), pool: "0x90" } }, sg)],
		["depositFinal false", mutateRoute({ depositFinal: false })],
		["depositFinal without a deposit", mutateRoute({ depositFinal: true })],
		["depositFinal beside an outcome", mutateRoute({ depositFinal: true, outcome: "not-sent" })],
		["outcome unknown", mutateRoute({ outcome: "refunded" })],
		["outcomeTxHash without outcome", mutateRoute({ outcomeTxHash: H("de") })],
		["outcomeAmount without outcome", mutateRoute({ outcomeAmount: "1" })],
		["outcomeAmount scientific", mutateRoute({ outcomeAmount: "1e6" }, sg)],
		["outcomeTxHash short", mutateRoute({ outcomeTxHash: "0xde" }, sg)],
		["extraDeposits object", mutateRoute({ extraDeposits: {} })],
		["extra txHash short", mutateRoute({ extraDeposits: [{ txHash: "0xee", leafIndex: "8", amount: "5" }] })],
		["extra leafIndex non-decimal", mutateRoute({ extraDeposits: [{ txHash: H("ee"), leafIndex: "8x", amount: "5" }] })],
		["extra amount missing", mutateRoute({ extraDeposits: [{ txHash: H("ee"), leafIndex: "8" }] })],
	])("%s rejects", (_label, rec) => {
		expect(() => validateCrossChainRecord(rec)).toThrow(REJECT)
	})
})

// ── byte pins ───────────────────────────────────────────────────────────────────────────────────

const NOW = 1_760_000_000_000
const SEALER = A("5e")
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex")
const BINDING = {
	site: "https://testnet.app.unleashed.systems",
	chainId: 11155111,
	portal: A("a1"),
	bridge: H("ab"),
	secretHashHex: H("04"),
}
/** The pre-existing blobs below were sealed by `EncryptionKey.fromPassword("0xsig-deterministic")`, which is what a
 *  legacy key over this signature derives. */
const legacyKey = await RecoveryKey.derive(async () => "0xsig-deterministic", BINDING, "legacy")
const key = await RecoveryKey.derive(async () => "0xsig-deterministic", BINDING, "site")

function memKV(): KV {
	const m = new Map<string, string>()
	return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) }
}

/** A copy, not the shared cross-chain fixture's: these bytes predate it and must not move with it. */
const LEGACY_TOKEN = {
	erc20: A("e2"),
	portal: A("a1"),
	l2Token: H("11"),
	nameWord: `0x00${"4e".repeat(31)}`,
	symbolWord: `0x00${"54".repeat(31)}`,
	decimals: 6,
	displaySymbol: "USDC",
	registerKey: H("22"),
	registerIndex: "5",
}

const ETH = { chainId: 11155111 }
/** One record of every Ethereum-origin shape, in each writer's field order. */
const LEGACY_RECORDS = [
	{
		schema: 1,
		id: H("01"),
		direction: "deposit",
		isPrivate: false,
		amount: "100",
		createdAt: 1,
		updatedAt: NOW,
		...ETH,
		portal: A("0f"),
		bridge: H("0b"),
		recipient: H("10"),
		secretHashHex: H("01"),
		secret: H("07"),
		depositTxHash: H("d1"),
		leafIndex: "7",
	},
	{
		schema: 2,
		id: H("02"),
		direction: "deposit",
		isPrivate: true,
		amount: "200",
		createdAt: 1,
		updatedAt: NOW,
		completedAt: 9,
		...ETH,
		portal: A("0f"),
		bridge: H("0b"),
		recipient: H("10"),
		secretHashHex: H("02"),
		sealedEnvelope: "c2VhbGVk",
		sealerL1: SEALER,
		assetKind: "fee-juice",
		fuel: {
			amount: "250",
			secret: H("f0"),
			secretHashHex: H("fe"),
			minOutput: "450",
			leafIndex: "8",
			received: "487",
			claimAttempt: true,
			consumed: true,
			bridgeSecretSalt: H("5a"),
		},
	},
	{
		schema: 1,
		id: H("03"),
		direction: "withdraw",
		isPrivate: false,
		amount: "40",
		createdAt: 1,
		updatedAt: NOW,
		...ETH,
		portal: A("0f"),
		bridge: H("0b"),
		recipientL1: SEALER,
		exitTxHash: H("03"),
		exitBlock: 5,
	},
	{
		schema: 3,
		id: H("04"),
		direction: "deposit",
		isPrivate: true,
		amount: "99000000",
		createdAt: 1,
		updatedAt: NOW,
		...ETH,
		portal: A("a1"),
		bridge: H("ab"),
		recipient: H("10"),
		secretHashHex: H("04"),
		sealedEnvelope: "c2VhbGVk",
		sealerL1: SEALER,
		sender: SEALER,
		depositTxHash: H("d4"),
		leafIndex: "9",
		messageHash: H("7e"),
		registers: true,
		intent: "token+gas",
		token: LEGACY_TOKEN,
		fuel: { amount: "1000000", secret: H("f4"), secretHashHex: H("e4"), minOutput: "450" },
	},
	{
		schema: 3,
		id: H("05"),
		direction: "deposit",
		isPrivate: false,
		amount: "0",
		createdAt: 1,
		updatedAt: NOW,
		...ETH,
		portal: A("f1"),
		bridge: H("05"),
		recipient: H("10"),
		secretHashHex: H("05"),
		intent: "gas",
		fuel: { amount: "5", secret: H("f5"), secretHashHex: H("e5"), minOutput: "1" },
	},
	{
		schema: 3,
		id: H("06"),
		direction: "withdraw",
		isPrivate: false,
		amount: "5",
		createdAt: 1,
		updatedAt: NOW,
		...ETH,
		portal: A("a1"),
		bridge: H("ab"),
		recipientL1: SEALER,
		exitTxHash: H("06"),
		consumeTxHash: H("c6"),
		intent: "token",
		token: LEGACY_TOKEN,
	},
] as unknown as BridgeJournalRecord[]

const V2_INPUT = { secret: H("07"), recipient: H("10"), amount: "0099000000", sealerL1: SEALER, leafIndex: "9", salt: H("5a") }
const V2_PLAINTEXT = `{"secret":"${H("07")}","recipient":"${H("10")}","amount":"99000000","sealerL1":"${SEALER}","leafIndex":"9","salt":"${H("5a")}","v":2}`
/** Sealed by the pre-schema-4 code under `legacyKey`. */
const V2_BLOB =
	"AFFdHYXn/frYjUNxxb4W2TJ+gUqF18QxnR0ncO6r67GOQua/BhHe0yqwut+Th1hlIi1YE0kqL0eT2v6wX/BE+XlLK7CZ2/FMvd0ytfORUAtyByOZ/gi5XOPZX2X19YRjUmU30vUuXndk0Sj6H/RMAmXl0jr6b+08YtoCMhGbl0qbXB2Mrtv6e9S62KJmKJ9AdJrZRLdIOwJSyPnqxMGxNwcZZ3ioORaY1JXFn4Y6J6KShpTcR3XrrrbiLQemgZQxZB/+hhEWp3fjDXhS2UErjO7QCRAvXQ0CVsbzYyR54KUdALA8Q4l3ksTncjnfl/o5nXQtLrlYO9RvSf3RJr1Yk0XJuI0BlXQpBvVfRsLwJtnCiNqm7aqzio0kjDfddHBFRlvTqZNuxnqhuPsncT0SihDm3a+rrOSMc4+v3xr9ImmEG7CqPoeAnJg5tWYXLTZ9UQuwxqsElAkACqvU18lpsEMfgMDWxwMHU+7W"

/** Written by the format-1 exporter (header with the exporting account, blob sealed under `legacyKey`). */
const FORMAT1_FILE: LegacyBridgeBackupFile = {
	format: "unleashed-bridge-backup",
	v: 1,
	chainId: 11155111,
	portal: A("a1"),
	bridge: H("ab"),
	direction: "deposit",
	id: H("04"),
	sealerL1: SEALER,
	blob: "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",
}

/** The file with its random-IV blob blanked, and the sealed plaintext, as digests. */
async function backupDigests(record: Parameters<typeof sealBridgeBackup>[1]) {
	const file = await sealBridgeBackup(key, record)
	return { file, header: sha256(JSON.stringify({ ...file, blob: "" })), payload: sha256(await key.open(file.blob)) }
}

describe("byte pins", () => {
	afterEach(() => vi.restoreAllMocks())

	it("an existing journal is written, loaded and re-written to the same bytes, under JOURNAL_KEY only", () => {
		vi.spyOn(Date, "now").mockReturnValue(NOW)
		const kv = memKV()
		for (const rec of LEGACY_RECORDS) upsertRecord(kv, rec)
		const stored = kv.getItem(JOURNAL_KEY) as string
		expect(sha256(stored)).toBe("61c6197a1b7d450fd5781b6941eae102c897cb621a71483daae98d0d87598a47")
		expect(loadJournal(kv)).toEqual(JSON.parse(stored).records)
		patchRecord(kv, H("04"), {})
		expect(kv.getItem(JOURNAL_KEY)).toBe(stored)
		expect(kv.getItem(CROSSCHAIN_JOURNAL_KEY)).toBeNull()
	})

	it("an existing v2 envelope opens to the same plaintext, and a fresh seal writes that plaintext", async () => {
		expect(await legacyKey.open(V2_BLOB)).toBe(V2_PLAINTEXT)
		expect(await openDepositEnvelope(legacyKey, V2_BLOB)).toEqual({ ...JSON.parse(V2_PLAINTEXT) })
		expect(await key.open(await sealDepositEnvelope(key, V2_INPUT))).toBe(V2_PLAINTEXT)
	})

	it("a format-1 recovery file still parses and opens to its record under the legacy key", async () => {
		// The header digest the format-1 exporter pinned: this fixture is byte for byte what it wrote.
		expect(sha256(JSON.stringify({ ...FORMAT1_FILE, blob: "" }))).toBe(
			"7773e5242251da504430eb2b3d52f7b8ac8a56c32ed4e344a41b11120e072dad",
		)
		const file = parseBackupFile(JSON.stringify(FORMAT1_FILE))
		expect(await openBridgeBackup(legacyKey, file)).toEqual(LEGACY_RECORDS[3])
		await expect(openBridgeBackup(key, file)).rejects.toThrow(/wasn't sealed by the connected Ethereum account/)
	})

	it("a new recovery file keeps the sealed payload bytes; only its header changed", async () => {
		const { file, header, payload } = await backupDigests(LEGACY_RECORDS[3])
		expect(header).toBe("826f79da8c81ef88b6ef2dd643103caf57339d9f6c3631f2f0e31194926de767")
		expect(payload).toBe("d5b91fd58d983efb23f9df7200f3ef9b98d82166394098d22927f1337063154f")
		expect(await openBridgeBackup(key, file)).toEqual(LEGACY_RECORDS[3])
	})

	it("schema 4: the cross-chain journal and a cross-chain recovery file", async () => {
		vi.spyOn(Date, "now").mockReturnValue(NOW)
		const kv = memKV()
		for (const rec of [xc, sg]) upsertRecord(kv, rec)
		expect(sha256(kv.getItem(CROSSCHAIN_JOURNAL_KEY) as string)).toBe(
			"971de04ccfac5f18ce3eeb8faa2c93d6de110307d513d37616c285ebbe7fa7a1",
		)
		expect(kv.getItem(JOURNAL_KEY)).toBeNull()
		const { file, header, payload } = await backupDigests(sg)
		expect([header, payload]).toEqual([
			"09cdef6e85bfc55bb7de9064eac818be77ef2677fb3e51cdd244d456a72f1216",
			"349d794e9960e1ffa2ef39f16ba2b2ce1dcfa2b2c88db6b69c57242557d6f780",
		])
		expect(await openAnyBridgeBackup(key, file)).toEqual(sg)
		await expect(openBridgeBackup(key, file)).rejects.toThrow(REJECT)
	})
})
