import type { BridgeJournalRecord, DepositJournalRecord, SendDepositRecord, WithdrawJournalRecord } from "@unleashed/bridge-core"
import { describe, expect, it } from "vitest"
import type { RecordRuntime } from "@/composables/useBridgeJournal"
import {
	type ActivityAction,
	type ActivityGroup,
	type RecordStatus,
	ageSpoken,
	ageWords,
	agoWords,
	classify,
	groupRecords,
	needsYouCount,
	rowStrings,
	runningWord,
	visibilityWords,
} from "./activity"
import { recordState, type WalletView } from "./record-policy"

const DEPLOY = { chainId: 11155111, portal: "0xportal", bridge: "0xbridge" }
const HASH = `0x${"ab".repeat(32)}`
const FUEL = { received: "10", leafIndex: "2" } as DepositJournalRecord["fuel"]

function dep(over: Partial<DepositJournalRecord> = {}): DepositJournalRecord {
	return {
		schema: 1,
		id: "0xd",
		direction: "deposit",
		isPrivate: false,
		amount: "100",
		createdAt: 1,
		updatedAt: 1,
		recipient: "0xaztec",
		secretHashHex: "0x1",
		...DEPLOY,
		...over,
	}
}
function wd(over: Partial<WithdrawJournalRecord> = {}): WithdrawJournalRecord {
	return {
		schema: 1,
		id: "0xw",
		direction: "withdraw",
		isPrivate: false,
		amount: "40",
		createdAt: 1,
		updatedAt: 1,
		recipientL1: "0xe",
		...DEPLOY,
		...over,
	}
}
const mine: WalletView = { status: "connected", selectedAccount: "0xaztec", accounts: [{ address: "0xaztec" }, { address: "0xother" }] }
const theirs: WalletView = { ...mine, selectedAccount: "0xother" }

const read = (rec: BridgeJournalRecord, rt: RecordRuntime = {}, wallet: WalletView = mine) => classify(rec, recordState(rec, rt, wallet))

describe("classify — the decision table, in the card's precedence", () => {
	type Row = [string, BridgeJournalRecord, RecordRuntime, WalletView, RecordStatus, ActivityGroup, boolean, ActivityAction]
	it.each<Row>([
		["busy record → running, no action", dep({ leafIndex: "1" }), { busy: true }, mine, "running", "running", false, null],
		["completed + stale busy → done wins", dep({ leafIndex: "1", completedAt: 5 }), { busy: true }, mine, "done", "done", false, null],
		[
			"completed, fuel unsettled, own account → CLAIM GAS",
			dep({ schema: 2, leafIndex: "1", completedAt: 5, fuel: FUEL }),
			{},
			mine,
			"done",
			"done",
			false,
			"claim-gas",
		],
		[
			"completed, fuel unsettled, other granted account → SWITCH",
			dep({ schema: 2, leafIndex: "1", completedAt: 5, fuel: FUEL }),
			{},
			theirs,
			"done",
			"done",
			false,
			"switch",
		],
		["blocked → lost, no dock action", dep({ leafIndex: "1", blocked: "stopped" }), {}, mine, "lost", "needs-you", true, null],
		[
			"completed + blocked → lost, not done",
			dep({ leafIndex: "1", completedAt: 5, blocked: "stopped" }),
			{},
			mine,
			"lost",
			"needs-you",
			true,
			null,
		],
		["busy + blocked → lost", dep({ leafIndex: "1", blocked: "stopped" }), { busy: true }, mine, "lost", "needs-you", true, null],
		[
			"busy + error attention → lost",
			dep({ leafIndex: "1" }),
			{ busy: true, attention: "error" },
			mine,
			"lost",
			"needs-you",
			true,
			null,
		],
		[
			"terminal attention → lost, no dock action",
			dep({ leafIndex: "1" }),
			{ attention: "malformed-record" },
			mine,
			"lost",
			"needs-you",
			true,
			null,
		],
		[
			"terminal attention × another account → lost, kept with lost, not counted, no action",
			dep({ leafIndex: "1" }),
			{ attention: "receipt-mismatch" },
			theirs,
			"lost",
			"needs-you",
			false,
			null,
		],
		["stuck before send → needs you, no dock action", dep(), {}, mine, "needs-you", "needs-you", true, null],
		["deposit hash, no leaf → CLAIM (leg recovery)", dep({ depositTxHash: HASH }), {}, mine, "needs-you", "needs-you", true, "claim"],
		["idle with a leaf → CLAIM", dep({ leafIndex: "1" }), {}, mine, "needs-you", "needs-you", true, "claim"],
		[
			"idle with a leaf, error attention → lost, RETRY",
			dep({ leafIndex: "1" }),
			{ attention: "error" },
			mine,
			"lost",
			"needs-you",
			true,
			"retry",
		],
		[
			"idle with a leaf, unknown outcome → lost, RETRY",
			dep({ leafIndex: "1" }),
			{ attention: "unknown-outcome" },
			mine,
			"lost",
			"needs-you",
			true,
			"retry",
		],
		[
			"claim sent, idle → CLAIM (keep watching)",
			dep({ leafIndex: "1", claimTxHash: HASH }),
			{},
			mine,
			"needs-you",
			"needs-you",
			true,
			"claim",
		],
		[
			"needs you × another granted account → other-account, not counted, SWITCH",
			dep({ leafIndex: "1" }),
			{},
			theirs,
			"needs-you",
			"other-account",
			false,
			"switch",
		],
		["exit not sent → needs you, no dock action", wd(), {}, mine, "needs-you", "needs-you", true, null],
		["idle proving withdraw → needs you, FINISH", wd({ exitTxHash: HASH }), {}, mine, "needs-you", "needs-you", true, "finish"],
		["exit sent, error → lost, RETRY", wd({ exitTxHash: HASH }), { attention: "error" }, mine, "lost", "needs-you", true, "retry"],
		["exit consumed → done", wd({ exitTxHash: HASH, consumeTxHash: HASH, completedAt: 9 }), {}, mine, "done", "done", false, null],
	])("%s", (_name, rec, rt, wallet, status, group, counts, action) => {
		expect(read(rec, rt, wallet)).toMatchObject({ status, group, counts, action })
	})

	it("rank orders lost on any account, needs-you, running, done, then other-account", () => {
		const ranks = [
			read(dep({ leafIndex: "1" }), { attention: "receipt-mismatch" }, theirs),
			read(dep({ leafIndex: "1" }), {}, mine),
			read(dep({ leafIndex: "1" }), { busy: true }, mine),
			read(dep({ leafIndex: "1", completedAt: 5 }), {}, mine),
			read(dep({ leafIndex: "1" }), {}, theirs),
		].map((c) => c.rank)
		expect(ranks).toEqual([0, 1, 2, 3, 4])
	})

	it("parity pin: the dock offers an action exactly where the card shows CLAIM / FINISH / CLAIM YOUR GAS", () => {
		const fixtures: Array<[BridgeJournalRecord, RecordRuntime, WalletView]> = [
			[dep(), {}, mine],
			[dep({ leafIndex: "1" }), {}, mine],
			[dep({ leafIndex: "1" }), { busy: true }, mine],
			[dep({ leafIndex: "1" }), { attention: "stale-deployment" }, mine],
			[dep({ leafIndex: "1", blocked: "x" }), {}, mine],
			[dep({ depositTxHash: HASH }), {}, mine],
			[dep({ leafIndex: "1" }), {}, theirs],
			[dep({ schema: 2, leafIndex: "1", completedAt: 5, fuel: FUEL }), {}, mine],
			[dep({ leafIndex: "1", completedAt: 5 }), {}, mine],
			[wd(), {}, mine],
			[wd({ exitTxHash: HASH }), {}, mine],
			[wd({ exitTxHash: HASH }), { busy: true }, mine],
		]
		for (const [rec, rt, wallet] of fixtures) {
			const s = recordState(rec, rt, wallet)
			const cardOffers = s.showClaim || s.showFinish || s.fuelRecoverable
			expect(classify(rec, s).action !== null, JSON.stringify({ id: rec.id, rt, wallet: wallet.selectedAccount })).toBe(cardOffers)
		}
	})
})

describe("rows", () => {
	it("needsYouCount counts a lost row and skips an other-account one; groups sort newest first", () => {
		const rows = [
			{ id: "a", group: "needs-you" as const, counts: true, createdAt: 1 },
			{ id: "b", group: "needs-you" as const, counts: true, createdAt: 3 },
			{ id: "c", group: "running" as const, counts: false, createdAt: 2 },
			{ id: "d", group: "done" as const, counts: false, createdAt: 4 },
			{ id: "e", group: "other-account" as const, counts: false, createdAt: 5 },
		]
		const lost = classify(dep({ leafIndex: "1", blocked: "x" }), recordState(dep({ leafIndex: "1", blocked: "x" }), {}, mine))
		expect(needsYouCount([...rows, { counts: lost.counts }])).toBe(3)
		expect(groupRecords(rows).otherAccount.map((r) => r.id)).toEqual(["e"])
		expect(groupRecords(rows).needsYou.map((r) => r.id)).toEqual(["b", "a"])
		expect(groupRecords(rows).running.map((r) => r.id)).toEqual(["c"])
	})

	it("runningWord names proving as an activity and any other phase by its label", () => {
		expect(runningWord(wd({ exitTxHash: HASH }), { busy: true })).toBe("Proving")
		expect(runningWord(dep({ leafIndex: "1" }), { busy: true, step: "syncing" })).toBe("Crossing")
	})

	it("visibilityWords: privacy as a word, plus gas when a fuel leg rides along", () => {
		expect(visibilityWords(dep({ isPrivate: true }))).toBe("private")
		expect(visibilityWords(dep({ schema: 2, fuel: FUEL }))).toBe("public + gas")
		const send = { ...dep({ id: "0xs" }), schema: 3, intent: "token+gas", token: undefined } as unknown as SendDepositRecord
		expect(visibilityWords(send)).toBe("public + gas")
		expect(visibilityWords(dep({ assetKind: "fee-juice" }))).toBe("public")
	})

	it("rowStrings strips and caps a persisted symbol (a restore file can carry anything)", () => {
		const rec = dep({
			id: "0xs",
			schema: 3,
			intent: "token",
			token: { displaySymbol: "US‮DC", decimals: 6 },
		} as unknown as Partial<DepositJournalRecord>)
		expect(rowStrings(rec).symbol).toBe("USDC")
	})

	it("rowStrings shows a gas-only send's Fee Juice, never the token it paid", () => {
		const gasOnly = (fuel: object) =>
			dep({ id: "0xg", schema: 3, intent: "gas", amount: "5000000", fuel } as unknown as Partial<DepositJournalRecord>)
		expect(rowStrings(gasOnly({ minOutput: "1", received: "2000000000000000000" }))).toEqual({
			amount: "2.00",
			symbol: "FJ",
			qualifier: "before claim fees",
		})
		expect(rowStrings(gasOnly({ minOutput: "1000000000000000000" }))).toEqual({
			amount: "≥ 1.00",
			symbol: "FJ",
			qualifier: "before claim fees",
		})
	})

	it("an age is abbreviated beside other facts, a sentence's time in prose, and spelled out when spoken", () => {
		const t = 10 * 60_000
		const at = (ms: number) => [ageWords(t, t + ms), agoWords(t, t + ms), ageSpoken(t, t + ms)]
		expect(at(10_000)).toEqual(["now", "just now", "just now"])
		expect(at(60_000)).toEqual(["1 min", "1 min ago", "1 minute ago"])
		expect(at(5 * 3_600_000)).toEqual(["5 h", "5 h ago", "5 hours ago"])
		expect(at(24 * 3_600_000)).toEqual(["1 d", "1 d ago", "1 day ago"])
		expect(at(72 * 3_600_000)).toEqual(["3 d", "3 d ago", "3 days ago"])
	})
})
