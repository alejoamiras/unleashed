import type { BridgeJournalRecord } from "@unleashed/bridge-core"
import { enableAutoUnmount, mount } from "@vue/test-utils"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { nextTick, ref } from "vue"
import type { RecordRuntime } from "@/composables/useBridgeJournal"

enableAutoUnmount(afterEach)

const visibleRecords = ref<BridgeJournalRecord[]>([])
const lastCompleted = ref<{
	id: string
	direction: "deposit" | "withdraw"
	amount: string
	isPrivate: boolean
	assetKind?: "bridge-token" | "fee-juice"
	txHash?: string
	foreground?: boolean
} | null>(null)
const push = vi.fn()

const activeFlowId = ref<string | null>(null)
const runtime = ref<Record<string, RecordRuntime>>({})
vi.mock("@/composables/useBridgeJournal", () => ({
	useBridgeJournal: () => ({ visibleRecords, lastCompleted, runtime, activeFlowId }),
}))
vi.mock("@/composables/useBridgeWallet", () => ({
	useBridgeWallet: () => ({
		status: ref("connected"),
		selectedAccount: ref("0xaztec"),
		accounts: ref([{ address: "0xaztec" }, { address: "0xother" }]),
	}),
}))

// The generation reader validates the live manifest at module init, and the wallet session imports
// it. A bridge-less generation is enough for everything this suite asserts.
vi.mock("@/contracts/bridge-generation", () => ({
	HUB: undefined,
	HUB_ARTIFACT: { name: "TokenBridgeHub" },
	HUB_TOKEN_ARTIFACT: { name: "Token" },
	MANIFEST_TOKENS: [],
	TOKEN_CLASS_ID: undefined,
	SEND_GENERATION: undefined,
	IS_PLACEHOLDER: true,
	rebuildHubInstance: vi.fn(),
	rebuildHubTokenInstance: vi.fn(),
}))
vi.mock("@/composables/useToast", () => ({
	useToast: () => ({ push }),
}))

const restoreFile = vi.fn(async (_raw: string) => ({ id: "0xrestored", direction: "deposit" as const, amount: (5n * UNIT).toString() }))
vi.mock("@/composables/useBridgeBackup", () => ({
	useBridgeBackup: () => ({ restoreFile, exportBridge: vi.fn() }),
}))

import { TESTIDS } from "@/lib/testids"
import BridgeJournal from "./BridgeJournal.vue"
import BridgeJournalCard from "./BridgeJournalCard.vue"
// Amounts + symbol derive from the LIVE manifest (the token cutover changes both — a hardcoded
// 18-dec "AZLO" fixture breaks on a 6-dec USDC manifest).
// A journal record with no token block of its own renders under asset-label's generic fallback.
const BRIDGE_TOKEN_DECIMALS = 18
const BRIDGE_TOKEN_SYMBOL = "TOKEN"
const UNIT = 10n ** BigInt(BRIDGE_TOKEN_DECIMALS)

const sel = (t: string) => `[data-testid="${t}"]`
const recOf = (over: Partial<BridgeJournalRecord>): BridgeJournalRecord =>
	({ id: "0x", direction: "deposit", isPrivate: false, amount: (1n * UNIT).toString(), createdAt: 1, ...over }) as BridgeJournalRecord

describe("BridgeJournal", () => {
	beforeEach(() => {
		visibleRecords.value = []
		runtime.value = {}
		lastCompleted.value = null
		activeFlowId.value = null
		push.mockClear()
	})

	it("RESTORE: picking a file runs the ladder and toasts the result; failures toast the ladder copy", async () => {
		const w = mount(BridgeJournal, { global: { stubs: { BridgeJournalCard: true } } })
		expect(w.find(sel(TESTIDS.journalRestore)).exists()).toBe(true)
		const input = w.find(sel(TESTIDS.journalRestoreInput))
		const file = new File(['{"format":"unleashed-bridge-backup"}'], "b.json", { type: "application/json" })
		Object.defineProperty(input.element, "files", { value: [file], configurable: true })
		await input.trigger("change")
		await vi.waitFor(() => expect(restoreFile).toHaveBeenCalled())
		await nextTick()
		expect(push).toHaveBeenCalledWith(
			expect.objectContaining({ kind: "ok", text: expect.stringContaining(`Restored: 5.00 ${BRIDGE_TOKEN_SYMBOL}`) }),
		)

		// The restored record's own token at its own decimals, and a gas-only one's Fee Juice.
		for (const [restored, text] of [
			[
				{ schema: 3, intent: "token", amount: "2500000", token: { displaySymbol: "USDC", decimals: 6 } },
				"Restored: 2.50 USDC to Aztec.",
			],
			[
				{ schema: 3, intent: "gas", amount: "2500000", fuel: { minOutput: "1", received: (3n * UNIT).toString() } },
				"Restored: 3.00 FJ (before claim fees) to Aztec.",
			],
		] as const) {
			push.mockClear()
			restoreFile.mockResolvedValueOnce({ ...recOf({ id: "0xr" }), ...restored } as never)
			Object.defineProperty(input.element, "files", { value: [file], configurable: true })
			await input.trigger("change")
			await vi.waitFor(() => expect(push).toHaveBeenCalledWith(expect.objectContaining({ kind: "ok", text })))
		}

		push.mockClear()
		restoreFile.mockRejectedValueOnce(new Error("This bridge is already tracked here — nothing to restore."))
		Object.defineProperty(input.element, "files", { value: [file], configurable: true })
		await input.trigger("change")
		await vi.waitFor(() =>
			expect(push).toHaveBeenCalledWith(expect.objectContaining({ kind: "error", text: expect.stringContaining("already tracked") })),
		)
	})

	it("RESTORE: an oversized file is refused by name before it is ever read into memory", async () => {
		restoreFile.mockClear()
		const w = mount(BridgeJournal, { global: { stubs: { BridgeJournalCard: true } } })
		const input = w.find(sel(TESTIDS.journalRestoreInput))
		const huge = new File(["{}"], "huge.json", { type: "application/json" })
		Object.defineProperty(huge, "size", { value: 2 * 1024 * 1024, configurable: true })
		const text = vi.spyOn(huge, "text")
		Object.defineProperty(input.element, "files", { value: [huge], configurable: true })
		await input.trigger("change")
		await nextTick()
		expect(text).not.toHaveBeenCalled()
		expect(restoreFile).not.toHaveBeenCalled()
		expect(push).toHaveBeenCalledWith(expect.objectContaining({ kind: "error", text: expect.stringContaining("too large") }))
	})

	it("orders the records newest first, whatever they need, under a heading with no count", () => {
		const dep = (id: string, createdAt: number, over: Partial<BridgeJournalRecord> = {}) =>
			recOf({ id, createdAt, recipient: "0xaztec", leafIndex: "1", ...over } as Partial<BridgeJournalRecord>)
		visibleRecords.value = [
			dep("done", 5, { completedAt: 9 }),
			dep("running", 4),
			dep("needs", 1),
			dep("theirs", 6, { recipient: "0xother" } as Partial<BridgeJournalRecord>),
			dep("theirs-lost", 2, { recipient: "0xother" } as Partial<BridgeJournalRecord>),
			dep("blocked", 3, { blocked: "stopped" }),
		]
		runtime.value = { running: { busy: true }, "theirs-lost": { attention: "receipt-mismatch" } }
		const w = mount(BridgeJournal, { global: { stubs: { BridgeJournalCard: true } } })
		const ids = w.findAllComponents(BridgeJournalCard).map((c) => (c.props("record") as BridgeJournalRecord).id)
		expect(ids).toEqual(["theirs", "done", "running", "blocked", "theirs-lost", "needs"])
		expect(w.find(".count").exists()).toBe(false)
		expect(w.findAll("ul[role=list] > li")).toHaveLength(6)
	})

	it("renders the empty state from visibleRecords (the hide filter feeds this list)", () => {
		const w = mount(BridgeJournal, { global: { stubs: { BridgeJournalCard: true } } })
		expect(w.find(sel(TESTIDS.journalEmpty)).exists()).toBe(true)
	})

	it("kind='fee-juice' lists ONLY fuel records (the Fuel tab's own bridges)", () => {
		visibleRecords.value = [recOf({ id: "0xtok", assetKind: "bridge-token" }), recOf({ id: "0xfuel", assetKind: "fee-juice" })]
		const w = mount(BridgeJournal, { props: { kind: "fee-juice" }, global: { stubs: { BridgeJournalCard: true } } })
		const cards = w.findAllComponents(BridgeJournalCard)
		expect(cards).toHaveLength(1)
		expect(cards[0].props("record")).toMatchObject({ id: "0xfuel" })
	})
})
