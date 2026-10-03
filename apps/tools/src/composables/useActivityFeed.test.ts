import type { BridgeJournalRecord, DepositJournalRecord } from "@unleashed/bridge-core"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { computed, ref } from "vue"
import type { RecordRuntime } from "@/composables/useBridgeJournal"

const records = ref<BridgeJournalRecord[]>([])
const activeFlowId = ref<string | null>(null)
const runtime = ref<Record<string, RecordRuntime>>({})
const visibleRecords = computed(() => records.value.filter((r) => r.id !== activeFlowId.value))
vi.mock("@/composables/useBridgeJournal", () => ({ useBridgeJournal: () => ({ records, visibleRecords, runtime, activeFlowId }) }))
vi.mock("@/composables/useBridgeWallet", () => ({
	useBridgeWallet: () => ({
		status: ref("connected"),
		selectedAccount: ref("0xaztec"),
		accounts: ref([{ address: "0xaztec" }, { address: "0xother" }]),
	}),
}))
const now = ref(60 * 60_000)
vi.mock("@/lib/clock", () => ({ useNow: () => now }))

import { useActivityFeed } from "./useActivityFeed"

const DEPLOY = { chainId: 11155111, portal: "0xportal", bridge: "0xbridge" }
function dep(over: Partial<DepositJournalRecord> = {}): DepositJournalRecord {
	return {
		schema: 1,
		id: "0xd",
		direction: "deposit",
		isPrivate: false,
		amount: "1000000000000000000",
		createdAt: 1,
		updatedAt: 1,
		recipient: "0xaztec",
		secretHashHex: "0x1",
		...DEPLOY,
		...over,
	}
}

describe("useActivityFeed", () => {
	beforeEach(() => {
		records.value = []
		runtime.value = {}
		activeFlowId.value = null
	})

	it("groups rows newest first; counts and auto-opens lost and needs-you rows of the active account only", () => {
		records.value = [
			dep({ id: "claim", leafIndex: "1", createdAt: 10 }),
			dep({ id: "blocked", leafIndex: "1", blocked: "stopped", createdAt: 20 }),
			dep({ id: "busy", leafIndex: "1", createdAt: 30 }),
			dep({ id: "done", leafIndex: "1", completedAt: 5, createdAt: 40 }),
			dep({ id: "theirs", leafIndex: "1", recipient: "0xother", createdAt: 50 }),
		]
		runtime.value = { busy: { busy: true } }
		const feed = useActivityFeed()
		expect(feed.grouped.value.needsYou.map((r) => r.id)).toEqual(["blocked", "claim"])
		expect(feed.grouped.value.running.map((r) => r.id)).toEqual(["busy"])
		expect(feed.grouped.value.done.map((r) => r.id)).toEqual(["done"])
		expect(feed.grouped.value.otherAccount.map((r) => r.id)).toEqual(["theirs"])
		expect(feed.count.value).toBe(2)
		expect(feed.autoOpenIds.value).toEqual(["claim", "blocked"])
		expect(feed.rows.value.find((r) => r.id === "blocked")).toMatchObject({ status: "lost", action: null })
		expect(feed.rows.value.find((r) => r.id === "claim")).toMatchObject({
			action: "claim",
			route: "ETH → Aztec",
			visibility: "public",
			symbol: "TOKEN",
			amount: "1.00",
		})
	})

	it("lists the record the wizard is showing read-only under Running: no action, not counted, never opening the dock", () => {
		records.value = [dep({ id: "fg", leafIndex: "1" }), dep({ id: "other", leafIndex: "1" })]
		activeFlowId.value = "fg"
		const feed = useActivityFeed()
		expect(feed.rows.value.map((r) => r.id)).toEqual(["other", "fg"])
		expect(feed.rows.value.find((r) => r.id === "fg")).toMatchObject({
			foreground: true,
			group: "running",
			status: "needs-you",
			action: null,
			counts: false,
		})
		expect(feed.grouped.value.running.map((r) => r.id)).toEqual(["fg"])
		expect(feed.count.value).toBe(1)
		expect(feed.autoOpenIds.value).toEqual(["other"])
		expect(feed.liveIds.value.has("fg")).toBe(true)
	})

	it("an other-account record groups last; a gas-only foreground row shows its Fee Juice", () => {
		const gasOnly = {
			...dep({ id: "gas", amount: "5000000" }),
			schema: 3,
			intent: "gas",
			fuel: { minOutput: "1", received: "3000000000000000000" },
		} as unknown as BridgeJournalRecord
		records.value = [dep({ id: "theirs", leafIndex: "1", recipient: "0xother" }), gasOnly]
		runtime.value = { gas: { busy: true } }
		activeFlowId.value = "gas"
		const feed = useActivityFeed()
		expect(feed.grouped.value.otherAccount.map((r) => r.id)).toEqual(["theirs"])
		expect(feed.rows.value.find((r) => r.id === "gas")).toMatchObject({
			foreground: true,
			status: "running",
			amount: "3.00",
			symbol: "FJ",
		})
	})

	it("ages tick with the shared clock", () => {
		records.value = [dep({ id: "a", createdAt: now.value - 2 * 60_000 })]
		const feed = useActivityFeed()
		expect(feed.rows.value[0]?.age).toBe("2m ago")
		now.value += 60 * 60_000
		expect(feed.rows.value[0]?.age).toBe("1h ago")
	})
})
