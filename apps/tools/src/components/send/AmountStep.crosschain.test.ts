import { mount } from "@vue/test-utils"
import { describe, expect, it } from "vitest"
import type { CrossChainFigures } from "@/lib/crosschain-figures"
import type { GasLegPlan, SendIntent } from "@/lib/send-model"
import { TESTIDS } from "@/lib/testids"
import AmountStep, { type CrossChainAmount } from "./AmountStep.vue"

const sel = (t: string) => `[data-testid="${t}"]`

const FIGURES: CrossChainFigures = {
	srcAmount: 5_000_000n,
	delivered: 4_900_000n,
	relayFee: 100_000n,
	feeBps: 200,
	slice: 1_490_000n,
	tokenArrives: 3_410_000n,
	gasExpected: 1_490_000n * 10n ** 12n,
	gasFloor: 1_445_300n * 10n ** 12n,
	etaSeconds: 10,
	refundAfterSeconds: 7_200,
	limits: { min: 1_950_000n, max: 8_000_000n },
	fixed: false,
}
const GAS: GasLegPlan = {
	fuelAmount: 1_490_000n,
	fuelFj: 0n,
	quote: FIGURES.gasExpected ?? 0n,
	minFuelOutput: FIGURES.gasFloor ?? 0n,
	venue: { provider: "testnetSwapper" },
	capped: null,
}
const NOT_OVER = { over: false, blocks: false, minimum: 1_950_000n }

function step(crossChain: Partial<CrossChainAmount>, intent: SendIntent = "token+gas") {
	return mount(AmountStep, {
		attachTo: document.body,
		props: {
			direction: "l1-to-l2",
			token: { symbol: "USDC", decimals: 6 },
			balances: { l1: 40_000_000n },
			intent,
			amount: "5",
			isPrivate: false,
			gas: intent === "token" ? null : GAS,
			routeKind: "route",
			routeLoading: false,
			txTarget: 20,
			fjPerTx: 10n ** 17n,
			gasError: null,
			crossChain: {
				srcChainId: 84532,
				rail: "acrossV4",
				figures: FIGURES,
				ceiling: NOT_OVER,
				notice: null,
				expiresIn: 41_200,
				...crossChain,
			},
		},
	})
}

const continues = (w: ReturnType<typeof step>) => w.find(sel(TESTIDS.sendAmountNext)).attributes("disabled") === undefined

describe("AmountStep, cross-chain", () => {
	it("says what arrives and what the route costs, in the source token, with the quote's age", () => {
		const w = step({})
		expect(w.find(sel(TESTIDS.sendXcArrives)).text()).toBe("Arrives on Aztec ≈ 3.41 USDC")
		const fees = w.find(sel(TESTIDS.sendXcFees)).text()
		expect(w.find(sel(TESTIDS.sendXcFeeTotal)).text()).toBe("≈ 0.10 USDC · 2.0 %")
		expect(fees).toContain("Across relay fee, taken from the amount≈ 0.10 USDC")
		expect(fees).toContain("Paid in test ETH on Base Sepolianetwork fee")
		expect(w.find(sel(TESTIDS.sendXcQuoteAge)).text()).toBe("Quote refreshes in 0:42")
		expect(w.find(sel(TESTIDS.sendGasBreakdownToken)).text()).toContain("≈ 3.41 USDC")
		expect(continues(w)).toBe(true)
		w.unmount()
	})

	it("refuses a send over the fee ceiling where it blocks, offering the smallest amount under it, and only warns elsewhere", async () => {
		const blocked = step({ ceiling: { over: true, blocks: true, minimum: 13_000_000n } }, "token")
		const box = blocked.find(sel(TESTIDS.sendXcCeiling))
		expect(box.text()).toContain("Fees ≈ 0.10 USDC are 2.0 % of this send, over the 10 % limit.")
		expect(box.text()).toContain("Send at least ≈ 13.00 USDC.")
		expect(continues(blocked)).toBe(false)
		await blocked.find(sel(TESTIDS.sendXcUseMinimum)).trigger("click")
		expect(blocked.emitted("update:amount")?.at(-1)).toEqual(["13"])
		blocked.unmount()

		const warned = step({ ceiling: { over: true, blocks: false, minimum: 13_000_000n } }, "token")
		expect(warned.find(sel(TESTIDS.sendXcCeiling)).attributes("role")).toBe("status")
		expect(warned.find(sel(TESTIDS.sendXcUseMinimum)).exists()).toBe(false)
		expect(continues(warned)).toBe(true)
		warned.unmount()
	})

	it("tells a gas-only send its fee outweighs the gas, and puts a missing route in place of the fees", async () => {
		const gasOnly = step(
			{ figures: { ...FIGURES, srcAmount: 2_000_000n, delivered: 50_000n, relayFee: 1_950_000n, tokenArrives: null } },
			"gas",
		)
		expect(gasOnly.find(sel(TESTIDS.sendXcArrives)).text()).toBe("Arrives on Aztec ≈ 1.49 FJ as gas")
		expect(gasOnly.find(sel(TESTIDS.sendXcGasOverFee)).text()).toBe("Fees ≈ 1.95 USDC, more than the gas itself.")
		expect(gasOnly.find(sel(TESTIDS.sendXcCeiling)).exists()).toBe(false)
		gasOnly.unmount()

		const none = step({ figures: null, notice: { kind: "no-route" } })
		const notice = none.find(sel(TESTIDS.sendXcNotice))
		expect(notice.text()).toContain("The gas swap on Ethereum · Sepolia has no price for this amount right now. Nothing was signed.")
		expect(none.find(sel(TESTIDS.sendXcFees)).exists()).toBe(false)
		expect(continues(none)).toBe(false)
		await none.find(sel(TESTIDS.sendXcRetry)).trigger("click")
		expect(none.emitted("retry")).toHaveLength(1)
		none.unmount()

		const over = step({ figures: null, notice: { kind: "over-cap", max: "8.00" } })
		expect(over.find(sel(TESTIDS.sendXcNotice)).text()).toContain("A testnet send carries at most 8.00 USDC.")
		expect(over.find(sel(TESTIDS.sendXcRetry)).exists()).toBe(false)
		expect(continues(over)).toBe(false)
		over.unmount()
	})
})
