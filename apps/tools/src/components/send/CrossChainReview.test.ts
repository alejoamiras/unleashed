import { mount } from "@vue/test-utils"
import { describe, expect, it } from "vitest"
import type { CrossChainFigures } from "@/lib/crosschain-figures"
import type { SendPlan } from "@/lib/send-model"
import { TESTIDS } from "@/lib/testids"
import { ask, DEST_TOKEN, SRC_USDC } from "@/test/crosschain"
import CrossChainReview from "./CrossChainReview.vue"

const sel = (t: string) => `[data-testid="${t}"]`

const FIGURES: CrossChainFigures = {
	srcAmount: 5_000_000n,
	delivered: 4_510_000n,
	relayFee: 490_000n,
	feeBps: 980,
	slice: null,
	tokenArrives: 4_510_000n,
	gasExpected: null,
	gasFloor: null,
	etaSeconds: 10,
	refundAfterSeconds: 7_200,
	limits: { min: 1_950_000n, max: 8_000_000n },
	fixed: false,
}
const PLAN: SendPlan = { direction: "l1-to-l2", intent: "token", token: DEST_TOKEN, amount: 4_510_000n, isPrivate: false }
const GAS_FIGURES: CrossChainFigures = { ...FIGURES, slice: 1_000_000n, tokenArrives: 3_510_000n, gasExpected: 230n * 10n ** 18n }
const GAS_PLAN: SendPlan = {
	...PLAN,
	intent: "token+gas",
	isPrivate: true,
	gas: {
		fuelAmount: 1_000_000n,
		fuelFj: 0n,
		quote: 230n * 10n ** 18n,
		minFuelOutput: 223n * 10n ** 18n,
		venue: { provider: "testnetSwapper" },
		capped: null,
	},
}

function review(over: Record<string, unknown> = {}) {
	return mount(CrossChainReview, {
		attachTo: document.body,
		props: {
			plan: PLAN,
			ask: ask({ intent: "token" }),
			figures: FIGURES,
			symbol: "USDC",
			account: `0x2b6e${"0".repeat(56)}71f0`,
			slippageBps: 300,
			txCovered: null,
			expiresIn: 42_000,
			state: null,
			walletChainId: null,
			busy: false,
			error: null,
			...over,
		},
	})
}

describe("CrossChainReview", () => {
	it("states a testnet send as the testnet board draws it, and signs", async () => {
		const w = review()
		expect(w.find(sel(TESTIDS.sendXcTestnetNotice)).text()).toBe(
			"Testnet: delivery depends on Across's test relayer. If nobody delivers it within 2 hours, it is refunded to you on Base Sepolia.",
		)
		expect(w.find(sel(TESTIDS.sendReviewSend)).text()).toContain("5.00USDCfrom BASE Base Sepolia")
		expect(w.find(sel(TESTIDS.sendXcLimits)).text()).toBe("Across's testnet limits: at least ≈ 1.95, at most ≈ 8.00 USDC per send")
		expect(w.find(sel(TESTIDS.sendReviewArrives)).text()).toBe("Arrives≈ 4.51 USDC on Aztec")
		expect(w.find(sel(TESTIDS.sendReviewNetworkFee)).text()).toContain("≈ 0.49 USDC · 9.8 %")
		expect(w.find(sel(TESTIDS.sendXcYouSign)).text()).toBe(
			"You signOn Base Sepolia: approve exactly 5.00 USDC, then send. Later, one prompt on Aztec to claim.",
		)
		expect(w.find(sel(TESTIDS.sendXcFallback)).text()).toContain("your own address 0x51Cd…0f44 there instead")
		await w.find(sel(TESTIDS.sendReviewDetailsToggle)).trigger("click")
		expect(w.find(sel(TESTIDS.sendReviewTokenLink)).attributes("href")).toBe(`https://sepolia.basescan.org/token/${SRC_USDC}`)
		expect(w.find(sel(TESTIDS.sendXcRefund)).text()).toBe("Refund0x51Cd…0f44 on Base Sepolia, after 2 hours undelivered")
		await w.find(sel(TESTIDS.sendReviewConfirm)).trigger("click")
		expect(w.emitted("confirm")).toHaveLength(1)
		w.unmount()
	})

	it("states fixed terms in the limits' place, keeps the testnet notice, and times the wait by the manual fill", async () => {
		const fixed: CrossChainFigures = {
			...FIGURES,
			delivered: 3_750_000n,
			relayFee: 1_250_000n,
			feeBps: 2500,
			tokenArrives: 3_750_000n,
			etaSeconds: 7_200,
			limits: null,
			fixed: true,
		}
		const w = review({ figures: fixed })
		expect(w.find(sel(TESTIDS.sendXcTestnetNotice)).exists()).toBe(true)
		expect(w.find(sel(TESTIDS.sendXcLimits)).exists()).toBe(false)
		expect(w.find(sel(TESTIDS.sendXcFixedTerms)).text()).toBe(
			"Fixed testnet terms, not a quote: the relay fee is a fixed 25.0 % and the send waits for a manual fill on Ethereum · Sepolia.",
		)
		expect(w.find(sel(TESTIDS.sendReviewTakes)).text()).toBe(
			"TakesUp to 2 hours for a manual fill on Ethereum · Sepolia, a few minutes for Aztec to pick it up, then your claim.",
		)
		expect(w.text()).toContain("Terms valid for 0:42 · rebuilt before you sign")
		await w.find(sel(TESTIDS.sendReviewDetailsToggle)).trigger("click")
		expect(w.find(sel(TESTIDS.sendReviewDetails)).text()).toContain("QuoteFixed testnet terms, rebuilt every 60 s")
		w.unmount()
	})

	it("adds the gas leg, its venue and the private seal to what the user signs", async () => {
		const w = review({ plan: GAS_PLAN, figures: GAS_FIGURES, ask: ask({ isPrivate: true }), txCovered: 20 })
		expect(w.find(sel(TESTIDS.sendReviewGas)).text()).toBe("≈ 230 FJ gas on Aztec for ≈ 20 transactions · from 1.00 USDC")
		expect(w.find(sel(TESTIDS.sendXcYouSign)).text()).toContain(
			"On Base Sepolia: a free signature that locks the recovery secret on this device (not a transaction, costs nothing), then approve exactly 5.00 USDC",
		)
		await w.find(sel(TESTIDS.sendReviewDetailsToggle)).trigger("click")
		expect(w.find(sel(TESTIDS.sendReviewDetails)).text()).toContain(
			"Base Sepolia → Ethereum · Sepolia through LI.FI (Across). On Ethereum · Sepolia, 1.00 USDC → AZTEC through the testnet fuel swapper, then the gas leg is bridged.",
		)
		w.unmount()
	})

	it("puts what forbids signing in Sign and send's place: an expired quote, then the wrong chain", async () => {
		const expired = review({ state: { kind: "expired" } })
		expect(expired.find(sel(TESTIDS.sendReviewConfirm)).exists()).toBe(false)
		expect(expired.find(sel(TESTIDS.sendXcNotice)).text()).toContain("This quote expired.")
		await expired.find(sel(TESTIDS.sendXcRefresh)).trigger("click")
		expect(expired.emitted("act")).toHaveLength(1)
		expired.unmount()

		const elsewhere = review({ walletChainId: 11155111 })
		expect(elsewhere.find(sel(TESTIDS.sendReviewConfirm)).exists()).toBe(false)
		expect(elsewhere.find(sel(TESTIDS.sendWrongChain)).text()).toContain("This send starts on Base Sepolia.")
		await elsewhere.find(sel(TESTIDS.sendWrongChainSwitch)).trigger("click")
		expect(elsewhere.emitted("switch-chain")).toHaveLength(1)
		elsewhere.unmount()
	})
})
