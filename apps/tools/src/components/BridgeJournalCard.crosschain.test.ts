import type { CrossChainDepositRecord } from "@unleashed/bridge-core"
import { mount } from "@vue/test-utils"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ref } from "vue"
import type { RecordRuntime } from "@/composables/useBridgeJournal"
import { XC_CREATED, XC_SRC_TX, XC_TRANSPORT, xcRecord } from "@/test/crosschain-record"

const runtime = ref<Record<string, RecordRuntime>>({})
const discard = vi.fn()
vi.mock("@/composables/useBridgeJournal", () => ({
	useBridgeJournal: () => ({ runtime, runDepositClaim: vi.fn(), runWithdrawConsume: vi.fn(), discard, clearDone: vi.fn() }),
}))
vi.mock("@/composables/fuel-recovery", () => ({
	claimFuelStandalone: vi.fn(),
	overrideFuelClaim: vi.fn(),
	reconcileFuelConsumed: vi.fn(async () => {}),
}))
vi.mock("@/composables/useBridgeWallet", () => ({
	useBridgeWallet: () => ({ accounts: ref([{ address: "0xaztec" }]), selectedAccount: ref("0xaztec"), status: ref("connected") }),
}))
vi.mock("@/composables/useWalletConnection", () => ({ switchActiveAccount: vi.fn() }))
vi.mock("@/composables/useEthHeld", () => ({ useEthHeld: () => ref("0.40") }))
vi.mock("@/composables/leftover-approval", () => ({ leftoverAllowance: async () => 0n, revokeLeftover: vi.fn() }))

import { __resetShellForTests, useShell } from "@/composables/useShell"
import { TESTIDS } from "@/lib/testids"
import BridgeJournalCard from "./BridgeJournalCard.vue"

const sel = (t: string) => `[data-testid="${t}"]`
const card = (record: CrossChainDepositRecord) =>
	mount(BridgeJournalCard, { props: { record }, global: { stubs: { BridgePhaseRail: true } } })
const done = { completedAt: XC_CREATED + 60_000 }
const delivered = { outcome: "delivered-to-wallet" as const, outcomeAmount: "4900000" }

describe("BridgeJournalCard — a cross-chain send", () => {
	beforeEach(() => {
		__resetShellForTests()
		discard.mockClear()
	})

	it.each([
		{
			name: "broadcast, not yet on the rail",
			rec: xcRecord(),
			chip: "Sending",
			guide: "Waiting for Base Sepolia to confirm the send…",
			actions: [],
		},
		{
			name: "bridging",
			rec: xcRecord({}, { transport: XC_TRANSPORT }),
			chip: "Bridging",
			guide: "Across is moving your USDC to Ethereum · Sepolia. Nothing for you to do; usually 2–4 min.",
			actions: [TESTIDS.journalXcTrack],
		},
		{
			name: "finalizing",
			rec: xcRecord({}, delivered),
			chip: "Finalizing",
			guide: "Delivered to your Ethereum wallet, waiting for Ethereum · Sepolia to finalize.",
			actions: [],
		},
		{
			name: "not sent",
			rec: xcRecord(done, { outcome: "not-sent" }),
			chip: "Not sent",
			guide: "The send reverted on Base Sepolia, so nothing moved. Your 5.00 USDC is still in 0x3fA8…c41d.",
			actions: [TESTIDS.journalXcDismiss],
		},
		{
			name: "delivered to the wallet",
			rec: xcRecord(done, delivered),
			chip: "Delivered to wallet",
			guide: "4.90 USDC is in your Ethereum wallet 0x3fA8…c41d, not on Aztec. Continuing from Ethereum is a new send and needs ETH there for gas; you hold 0.40 ETH.",
			actions: [TESTIDS.journalXcContinue, TESTIDS.journalXcDismiss],
		},
		{
			name: "expired",
			rec: xcRecord(done, { outcome: "expired-on-source" }),
			chip: "Expired",
			guide: "It wasn’t filled on Ethereum · Sepolia within 2 hours. Refund pending on Base Sepolia, to 0x3fA8…c41d.",
			actions: [TESTIDS.journalXcDismiss],
		},
	])("$name: the sent amount, its chip, its guide and only its own actions", ({ rec, chip, guide, actions }) => {
		const w = card(rec)
		expect(w.get(".amt").text()).toBe("5.00 USDC")
		expect(w.get(".dir").text()).toBe("Base Sepolia → Aztec")
		expect(w.get("[data-status-chip]").text()).toBe(chip)
		expect(w.get(sel(TESTIDS.journalXcGuide)).text()).toBe(guide)
		const offered = [TESTIDS.journalXcContinue, TESTIDS.journalXcDismiss, TESTIDS.journalXcTrack].filter((t) => w.find(sel(t)).exists())
		expect(offered).toEqual(actions)
		for (const gone of [TESTIDS.journalClaim, TESTIDS.journalDiscard, TESTIDS.journalClear])
			expect(w.find(sel(gone)).exists()).toBe(false)
	})

	it("tracks a bridging send on LI.FI by its source transaction", () => {
		expect(
			card(xcRecord({}, { transport: XC_TRANSPORT }))
				.get(sel(TESTIDS.journalXcTrack))
				.attributes("href"),
		).toBe(`https://scan.li.fi/tx/${XC_SRC_TX}`)
	})

	it("Continue from Ethereum hands the wizard the delivered token and amount; Dismiss discards", async () => {
		const rec = xcRecord(done, delivered)
		const w = card(rec)
		await w.get(sel(TESTIDS.journalXcContinue)).trigger("click")
		const shell = useShell()
		expect(shell.section.value).toBe("send")
		expect(shell.takePrefill()).toEqual({
			token: `0x${"e2".repeat(20)}`,
			amount: 4_900_000n,
			intent: "token+gas",
			isPrivate: false,
			fromRecordId: rec.id,
		})
		await w.get(sel(TESTIDS.journalXcDismiss)).trigger("click")
		expect(discard).toHaveBeenCalledWith(rec.id)
	})

	it("an arrived send shows what landed, the extra deposit it found, and its receipt", async () => {
		const extra = { txHash: `0x${"ee".repeat(32)}` as `0x${string}`, leafIndex: "8", amount: "1000000" }
		const rec = xcRecord({ ...done, leafIndex: "7", claimTxHash: `0x${"cc".repeat(32)}` }, { extraDeposits: [extra] })
		const w = card(rec)
		expect(w.get(".amt").text()).toBe("4.41 USDC")
		expect(w.get("[data-status-chip]").text()).toBe("Arrived")
		expect(w.get(sel(TESTIDS.journalXcAnotherDeposit)).text()).toBe(
			"Another deposit for this send was found on Ethereum · Sepolia. No action needed.",
		)
		expect(w.findAll(sel(TESTIDS.journalTxLink)).map((a) => a.text())).toEqual(["Send tx", "Claim tx"])
		await w.get(sel(TESTIDS.journalXcReceipt)).trigger("click")
		expect(useShell().takeReceiptRequest()).toBe(rec.id)
	})
})
