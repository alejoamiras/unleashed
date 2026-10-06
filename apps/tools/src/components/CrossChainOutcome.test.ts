import type { CrossChainDepositRecord } from "@unleashed/bridge-core"
import { mount } from "@vue/test-utils"
import { describe, expect, it, vi } from "vitest"
import { ref } from "vue"
import { XC_CREATED, XC_SRC_TX, XC_TRANSPORT, xcRecord } from "@/test/crosschain-record"

const now = ref(XC_CREATED + 9 * 60_000)
vi.mock("@/lib/clock", () => ({ useNow: () => now }))
vi.mock("@/composables/useEthHeld", () => ({ useEthHeld: () => ref(undefined) }))

import type { OutcomeFigures } from "@/lib/crosschain-outcome"
import { TESTIDS } from "@/lib/testids"
import CrossChainOutcome from "./CrossChainOutcome.vue"

const sel = (t: string) => `[data-testid="${t}"]`
const ended = { completedAt: XC_CREATED + 60_000 }
const panel = (record: CrossChainDepositRecord, figures?: OutcomeFigures) =>
	mount(CrossChainOutcome, { props: { record, figures }, global: { stubs: { BridgePhaseRail: true } } })
const cards = (w: ReturnType<typeof panel>) => w.findAll(".card p:first-of-type").map((p) => p.text())

describe("CrossChainOutcome", () => {
	it("delivered: says where the money is, prices nothing it cannot read, and continues with the delivered token", async () => {
		const rec = xcRecord(ended, { outcome: "delivered-to-wallet", outcomeAmount: "4900000", outcomeTxHash: `0x${"de".repeat(32)}` })
		const w = panel(rec, { ethHeld: "0.40", continueQuote: { amount: "4.41", symbol: "USDC", gas: "230 FJ" } })
		expect(w.get("h2").text()).toBe("Delivered to your Ethereum wallet instead")
		expect(w.get(".sub").text()).toBe("Base Sepolia → Aztec · 5.00 USDC · public · stopped at the deposit, 8 min ago")
		expect(cards(w)).toEqual([
			"Across delivered your USDC to Ethereum · Sepolia, but the deposit into Aztec didn’t go through. So LI.FI sent the USDC to your own Ethereum wallet.",
			"The money is safe and yours, on Ethereum · Sepolia. It is not on Aztec yet. The LI.FI fee and the bridge fee are spent; nothing else was taken.",
			"Continue from Ethereum: a new send from your Ethereum wallet. You sign there and pay its gas in ETH. You hold 0.40 ETH on Ethereum · Sepolia.",
		])
		expect(w.get(".figure").text()).toBe("4.90 USDC in 0x3fA8…c41d on Ethereum · Sepolia")
		expect(w.get(".lands").text()).toBe("Lands as ≈ 4.41 USDC, public, plus ≈ 230 FJ gas.")
		expect(w.findAll(".tx dt").map((d) => d.text())).toEqual(["Sent on Base Sepolia", "Delivered on Ethereum · Sepolia", "Full trail"])
		expect(w.get(".band").text()).toBe("Continuing starts a new send from Ethereum, with its own recovery secret.")
		await w.get(sel(TESTIDS.xcOutcomeContinue)).trigger("click")
		await w.get(sel(TESTIDS.xcOutcomeDismiss)).trigger("click")
		expect(w.emitted("continue")?.[0]?.[0]).toMatchObject({ token: `0x${"e2".repeat(20)}`, amount: 4_900_000n, fromRecordId: rec.id })
		expect(w.emitted("dismiss")).toHaveLength(1)
	})

	it("expired and not sent: what happened from the record alone, then a new quote or a changed send", async () => {
		const expired = panel(xcRecord(ended, { outcome: "expired-on-source" }))
		expect(expired.get("h2").text()).toBe("Refund pending on Base Sepolia")
		expect(cards(expired)[0]).toBe(
			"This transfer waited 2 hours for a manual fill on Ethereum · Sepolia and wasn’t filled, so it expired.",
		)
		expect(expired.get(".figure").text()).toBe("5.00 USDC due back in 0x3fA8…c41d on Base Sepolia")
		expect(expired.get(sel(TESTIDS.xcOutcomeChangeSend)).text()).toBe("Pick another balance")

		const notSent = panel(xcRecord(ended, { outcome: "not-sent" }))
		expect(notSent.get("h2").text()).toBe("Nothing moved")
		expect(cards(notSent).slice(0, 2)).toEqual([
			"Base Sepolia rejected the transaction, so it never ran.",
			"Your USDC never left your wallet. The only cost is the Base Sepolia network fee for the attempt.",
		])
		expect(notSent.get(".tx").text()).toBe("Rejected on Base Sepolia0x5757…5757 · reverted, 0 USDC moved")
		await notSent.get(sel(TESTIDS.xcOutcomeNewQuote)).trigger("click")
		await notSent.get(sel(TESTIDS.xcOutcomeChangeSend)).trigger("click")
		expect(notSent.emitted("new-quote")).toHaveLength(1)
		expect(notSent.emitted("change-send")).toHaveLength(1)
	})

	it("stalled: a bridging send past twice its usual time, with its clock, LI.FI's trail and the last read", async () => {
		now.value = XC_CREATED + 24 * 60_000 + 10_000
		const w = panel(xcRecord({}, { transport: XC_TRANSPORT }), { checkedAt: now.value - 5_000 })
		expect(w.get("h2").text()).toBe("Bridging is taking longer than usual")
		expect(w.get(".sub").text()).toBe("Base Sepolia → Aztec · 5.00 USDC · public · 24:10 in the bridge, usually 2–4 min")
		expect(cards(w)[0]).toBe("Your USDC left Base Sepolia 24 minutes ago. Across hasn’t delivered it to Ethereum · Sepolia yet.")
		expect(w.get(sel(TESTIDS.xcOutcomeTrack)).attributes("href")).toBe(`https://scan.li.fi/tx/${XC_SRC_TX}`)
		expect(w.get(".aside").text()).toBe("Last checked a few seconds ago.")
		await w.setProps({ figures: { checkedAt: now.value - 3 * 60_000 } })
		expect(w.get(".aside").text()).toBe("Last checked 3 min ago.")
	})

	it("renders nothing while the stepper is still the right surface", () => {
		now.value = XC_CREATED + 60_000
		expect(panel(xcRecord()).find("section").exists()).toBe(false)
		expect(
			panel(xcRecord({}, { outcome: "not-sent" }))
				.find("section")
				.exists(),
		).toBe(false)
	})
})
