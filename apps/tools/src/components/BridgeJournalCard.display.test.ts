import type { BridgeJournalRecord, DepositJournalRecord } from "@unleashed/bridge-core"
import { mount } from "@vue/test-utils"
import { describe, expect, it, vi } from "vitest"
import { ref } from "vue"
import type { RecordRuntime } from "@/composables/useBridgeJournal"

const runtime = ref<Record<string, RecordRuntime>>({})
vi.mock("@/composables/useBridgeJournal", () => ({
	useBridgeJournal: () => ({ runtime, runDepositClaim: vi.fn(), runWithdrawConsume: vi.fn(), discard: vi.fn(), clearDone: vi.fn() }),
}))
vi.mock("@/composables/fuel-recovery", () => ({
	claimFuelStandalone: vi.fn(),
	overrideFuelClaim: vi.fn(),
	reconcileFuelConsumed: vi.fn(async () => {}),
}))
const accounts = ref<Array<{ address: string; alias?: string }>>([{ address: "0xaztec", alias: "Main" }])
vi.mock("@/composables/useBridgeWallet", () => ({
	useBridgeWallet: () => ({ accounts, selectedAccount: ref("0xaztec"), status: ref("connected") }),
}))
vi.mock("@/composables/useWalletConnection", () => ({ switchActiveAccount: vi.fn() }))

import { TESTIDS } from "@/lib/testids"
import BridgeJournalCard from "./BridgeJournalCard.vue"

const DEPLOY = { chainId: 11155111, portal: "0xportal", bridge: "0xbridge" }
function deposit(over: Partial<DepositJournalRecord> = {}): DepositJournalRecord {
	return {
		schema: 1,
		id: "0xd",
		direction: "deposit",
		isPrivate: false,
		amount: "1000000",
		createdAt: 1,
		updatedAt: 1,
		recipient: "0xaztec",
		secretHashHex: "0x1",
		...DEPLOY,
		...over,
	}
}
const sel = (t: string) => `[data-testid="${t}"]`

// The record is persisted, restorable text: whatever a file carries in `blocked` or in a token
// block's `displaySymbol` reaches the card, so both go through the same strip-and-cap as the token list.
describe("BridgeJournalCard — persisted text is stripped and capped", () => {
	it("a bidi-override symbol renders without the override", () => {
		const rec = {
			...deposit({ id: "0xs", leafIndex: "1" }),
			schema: 3,
			intent: "token",
			token: { displaySymbol: "US‮DC", decimals: 6 },
		} as unknown as BridgeJournalRecord
		const w = mount(BridgeJournalCard, { props: { record: rec } })
		expect(w.text()).toContain("1.00 USDC")
		expect(w.text()).not.toContain("‮")
	})

	it("a blocked reason keeps its sentence but a 400-character one is capped and a bidi mark dropped", () => {
		const sentence = "This token's registration on Ethereum no longer matches this record."
		expect(
			mount(BridgeJournalCard, { props: { record: deposit({ leafIndex: "1", blocked: sentence }) } })
				.find(sel(TESTIDS.journalAttention))
				.text(),
		).toBe(sentence)
		const w = mount(BridgeJournalCard, { props: { record: deposit({ leafIndex: "1", blocked: `\u202e${"x".repeat(400)}` }) } })
		const note = w.find(sel(TESTIDS.journalAttention))
		expect(note.text().length).toBeLessThan(300)
		expect(note.text().endsWith("…")).toBe(true)
		expect(note.text()).not.toContain("\u202e")
	})

	it("a recipient carrying bidi controls is shown and tooltipped without them; an impossible amount is a dash", () => {
		const hostile = `0x\u202e${"a".repeat(64)}`
		// The account chip renders only for another granted account.
		accounts.value = [{ address: "0xaztec", alias: "Main" }, { address: hostile }]
		const w = mount(BridgeJournalCard, { props: { record: deposit({ leafIndex: "1", recipient: hostile, amount: "1".repeat(120) }) } })
		const acct = w.get(sel(TESTIDS.journalAccount))
		expect(acct.text()).not.toContain("\u202e")
		expect(acct.attributes("title")).not.toContain("\u202e")
		expect(w.text()).toContain("— TOKEN")
	})
})
