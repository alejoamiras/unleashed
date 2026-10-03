import { mount } from "@vue/test-utils"
import { afterEach, describe, expect, it, vi } from "vitest"
import { nextTick } from "vue"
import type { Direction, GasLegPlan, ResolvedToken, SendIntent, TokenBalances } from "@/lib/send-model"
import { TESTIDS } from "@/lib/testids"
import AmountStep, { type RouteKind } from "./AmountStep.vue"

const sel = (t: string) => `[data-testid="${t}"]`
/** The always-mounted, visually hidden live region the reason lines are announced through. */
const ANNOUNCER = '.sr-only[aria-live="polite"]'

const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"

const TOKEN = {
	chainId: 1,
	address: USDC,
	symbol: "USDC",
	name: "USD Coin",
	decimals: 6,
	source: "manifest",
	logoKey: `1:${USDC}`,
	state: { kind: "registered", registration: {}, l2Token: "0x01" },
	portal: "0xportal",
	words: { nameWord: "0x01", symbolWord: "0x02" },
	l2Token: "0x01",
} as unknown as ResolvedToken

const GAS = {
	fuelAmount: 2_000_000n,
	fuelFj: 300_000_000_000_000_000n,
	quote: 300_000_000_000_000_000n,
	minFuelOutput: 285_000_000_000_000_000n,
	route: { path: [], zeroForOnes: [] },
	capped: null,
} as unknown as GasLegPlan

type Props = {
	direction: Direction
	token: { symbol: string; decimals: number }
	resolving?: boolean
	balances: TokenBalances
	intent: SendIntent
	amount: string
	isPrivate: boolean
	gas: GasLegPlan | null
	routeKind: RouteKind | null
	routeLoading: boolean
	txTarget: number
	fjPerTx: bigint | null
	gasError: string | null
	blockedReason?: string | null
	tokenOnlyBlocked?: string | null
}

function step(over: Partial<Props> = {}) {
	return mount(AmountStep, {
		attachTo: document.body,
		props: {
			direction: "l1-to-l2",
			token: TOKEN,
			balances: { l1: 10_000_000n },
			intent: "token",
			amount: "5",
			isPrivate: true,
			gas: null,
			routeKind: "route",
			routeLoading: false,
			txTarget: 20,
			fjPerTx: 100_000_000_000_000_000n,
			gasError: null,
			...over,
		},
	})
}

const errorText = (w: ReturnType<typeof step>) => w.find(sel(TESTIDS.sendAmountError)).text()

describe("AmountStep", () => {
	it("offers the three outcomes on a deposit and reports the choice", async () => {
		const w = step()
		await w.find(sel(TESTIDS.sendChoiceTokenGas)).trigger("click")
		expect(w.emitted("update:intent")).toEqual([["token+gas"]])
		w.unmount()
	})

	it("an exit has one outcome and no gas route line", () => {
		const w = step({ direction: "l2-to-l1", balances: { l2Private: 1_000_000n } })
		expect(w.find(sel(TESTIDS.sendChoiceGas)).exists()).toBe(false)
		expect(w.find(sel(TESTIDS.sendRouteStatus)).exists()).toBe(false)
		w.unmount()
	})

	it("says nothing about a working route, and announces one that cannot buy gas unless it is still being checked", async () => {
		expect(step().find(sel(TESTIDS.sendRouteStatus)).exists()).toBe(false)
		const w = step({ routeKind: "no-route" })
		const line = w.find(sel(TESTIDS.sendRouteStatus))
		expect(line.attributes("data-route")).toBe("no-route")
		expect(line.text()).toContain("can't buy Aztec gas")
		// The cards say it in sight; this line is only the announcement.
		expect(line.element.closest(ANNOUNCER)).not.toBeNull()
		// A route still being checked announces nothing — no spinner line, no stale outcome.
		await w.setProps({ routeLoading: true })
		expect(w.find(sel(TESTIDS.sendRouteStatus)).exists()).toBe(false)
		w.unmount()
	})

	it("a route that cannot be checked closes both gas cards with its own reason in place", () => {
		const w = step({ routeKind: "unavailable" })
		for (const id of [TESTIDS.sendChoiceTokenGas, TESTIDS.sendChoiceGas]) {
			expect(w.find(sel(id)).attributes("aria-disabled")).toBe("true")
			expect(w.find(sel(id)).text()).toContain("Gas options can't be checked right now.")
		}
		expect(w.find(sel(TESTIDS.sendRouteStatus)).attributes("data-route")).toBe("unavailable")
		w.unmount()
	})

	it("keeps the field's text verbatim — a trailing separator survives", async () => {
		const w = step()
		await w.find(sel(TESTIDS.sendAmountInput)).setValue("1.")
		expect(w.emitted("update:amount")).toEqual([["1."]])
		w.unmount()
	})

	it("the block cursor stands in for the caret only at the end of the value; anywhere else the native caret shows", async () => {
		const w = step({ amount: "12345" })
		const input = w.find(sel(TESTIDS.sendAmountInput))
		const el = input.element as HTMLInputElement
		const blockShown = () => w.find(".field").attributes("data-caret-at-end") === "true"
		el.setSelectionRange(5, 5)
		await input.trigger("focus")
		expect(blockShown()).toBe(true)
		el.setSelectionRange(2, 2)
		await input.trigger("keyup")
		expect(blockShown()).toBe(false)
		el.setSelectionRange(1, 5)
		await input.trigger("select")
		expect(blockShown(), "a selection running to the end is not a caret").toBe(false)
		el.setSelectionRange(5, 5)
		await input.trigger("click")
		expect(blockShown()).toBe(true)
		// A held arrow key repeats keydown with no keyup; the caret moves after the handler.
		await input.trigger("keydown")
		el.setSelectionRange(3, 3)
		await new Promise((resolve) => setTimeout(resolve, 0))
		expect(blockShown(), "a key repeat resyncs").toBe(false)
		// A value the parent replaces (Max, reformatting) resyncs with no input event of its own.
		el.setSelectionRange(5, 5)
		await w.setProps({ amount: "99999" })
		await nextTick()
		expect(blockShown(), "a parent-driven value resyncs").toBe(true)
		w.unmount()
	})

	it("a trailing separator is an amount still being typed: no red line, and no continuing from it", () => {
		const w = step({ amount: "1." })
		expect(w.find(sel(TESTIDS.sendAmountError)).exists()).toBe(false)
		expect(w.find(sel(TESTIDS.sendAmountNext)).attributes("disabled")).toBeDefined()
		w.unmount()
	})

	it("refuses more decimal places than the token has when they arrive already typed", () => {
		const w = step({ amount: "1.1234567" })
		expect(errorText(w)).toContain("6 decimal places")
		expect(w.find(sel(TESTIDS.sendAmountNext)).attributes("disabled")).toBeDefined()
		w.unmount()
	})

	it("cuts extra decimal places on the way in instead of reporting them", async () => {
		const w = step()
		await w.find(sel(TESTIDS.sendAmountInput)).setValue("1.1234567")
		expect(w.emitted("update:amount")).toEqual([["1.123456"]])
		const whole = step({ token: { symbol: "WHOLE", decimals: 0 } as never })
		await whole.find(sel(TESTIDS.sendAmountInput)).setValue("12.5")
		expect(whole.emitted("update:amount")).toEqual([["12"]])
		w.unmount()
		whole.unmount()
	})

	it("a keystroke shows no red line until typing pauses or the field is left", async () => {
		vi.useFakeTimers()
		try {
			const w = step()
			const input = w.find(sel(TESTIDS.sendAmountInput))
			await input.setValue("1e")
			await w.setProps({ amount: "1e" })
			expect(w.find(sel(TESTIDS.sendAmountError)).exists()).toBe(false)
			expect(input.attributes("aria-invalid")).toBeUndefined()
			await vi.advanceTimersByTimeAsync(700)
			expect(errorText(w)).toContain("as a number")
			// A fresh keystroke hides it again; leaving the field shows it at once.
			await input.setValue("1e6")
			await w.setProps({ amount: "1e6" })
			expect(w.find(sel(TESTIDS.sendAmountError)).exists()).toBe(false)
			await input.trigger("blur")
			expect(errorText(w)).toContain("as a number")
			w.unmount()
		} finally {
			vi.useRealTimers()
		}
	})

	it("the gas route's complaint waits for the same pause as the field's own", async () => {
		vi.useFakeTimers()
		try {
			const w = step({ intent: "token+gas", gas: GAS, gasError: "That amount cannot buy gas." })
			expect(w.find(sel(TESTIDS.sendGasBreakdown)).text()).toContain("cannot buy gas")
			const input = w.find(sel(TESTIDS.sendAmountInput))
			await input.setValue("2")
			await w.setProps({ amount: "2" })
			expect(w.find(sel(TESTIDS.sendGasBreakdown)).text()).not.toContain("cannot buy gas")
			await vi.advanceTimersByTimeAsync(700)
			expect(w.find(sel(TESTIDS.sendGasBreakdown)).text()).toContain("cannot buy gas")
			w.unmount()
		} finally {
			vi.useRealTimers()
		}
	})

	it("refuses text that is not a number", () => {
		const w = step({ amount: "1e6" })
		expect(errorText(w)).toContain("as a number")
		w.unmount()
	})

	it("refuses zero", () => {
		const w = step({ amount: "0.000000" })
		expect(errorText(w)).toContain("greater than zero")
		w.unmount()
	})

	it("refuses more than the balance it would spend", () => {
		const w = step({ amount: "10.000001" })
		expect(errorText(w)).toContain("more than your balance")
		w.unmount()
	})

	it("an exit checks against the balance the privacy choice names", async () => {
		const w = step({ direction: "l2-to-l1", amount: "3", balances: { l2Private: 2_000_000n, l2Public: 9_000_000n } })
		expect(errorText(w)).toContain("more than your balance")
		await w.setProps({ isPrivate: false })
		expect(w.find(sel(TESTIDS.sendAmountError)).exists()).toBe(false)
		w.unmount()
	})

	it("says nothing about an empty field, but will not continue from it", () => {
		const w = step({ amount: "" })
		expect(w.find(sel(TESTIDS.sendAmountError)).exists()).toBe(false)
		expect(w.find(sel(TESTIDS.sendAmountNext)).attributes("disabled")).toBeDefined()
		w.unmount()
	})

	it("tapping the balance line fills the field at full precision, not the display rounding", async () => {
		const w = step({ balances: { l1: 12_345_678n } })
		await w.find(sel(TESTIDS.sendAmountMax)).trigger("click")
		expect(w.emitted("update:amount")).toEqual([["12.345678"]])
		w.unmount()
	})

	it("the balance line is the max control — no separate link — and inert while the balance is unknown", () => {
		const w = step({ balances: {} })
		const max = w.find(sel(TESTIDS.sendAmountMax))
		expect(max.text()).toContain("Balance")
		expect(max.attributes("aria-label")).toBe("Use the whole balance")
		expect(w.text()).not.toMatch(/use all|max/i)
		expect(max.attributes("disabled")).toBeDefined()
		w.unmount()
	})

	it("shows the gas breakdown only when the send actually buys gas", async () => {
		const w = step()
		expect(w.find(sel(TESTIDS.sendGasBreakdown)).exists()).toBe(false)
		await w.setProps({ intent: "token+gas", gas: GAS })
		expect(w.find(sel(TESTIDS.sendGasBreakdownToken)).text()).toContain("3.00 USDC")
		w.unmount()
	})

	it("passes a changed tx target up", async () => {
		const w = step({ intent: "token+gas", gas: GAS })
		await w.find(sel(TESTIDS.sendGasTxTarget)).setValue("8")
		expect(w.emitted("update:txTarget")).toEqual([[8]])
		w.unmount()
	})

	it("the privacy row is one switch that reports its flip", async () => {
		const w = step()
		const toggle = w.find(sel(TESTIDS.sendPrivateToggle))
		expect(toggle.attributes("role")).toBe("switch")
		expect(toggle.attributes("aria-checked")).toBe("true")
		await toggle.trigger("click")
		expect(w.emitted("update:isPrivate")).toEqual([[false]])
		w.unmount()
	})

	it("will not continue into a gas send whose plan is missing", async () => {
		const w = step({ intent: "gas", gas: null })
		expect(w.find(sel(TESTIDS.sendAmountNext)).attributes("disabled")).toBeDefined()
		await w.setProps({ gas: GAS })
		expect(w.find(sel(TESTIDS.sendAmountNext)).attributes("disabled")).toBeUndefined()
		w.unmount()
	})

	it("moves both ways", async () => {
		const w = step()
		await w.find(sel(TESTIDS.sendAmountBack)).trigger("click")
		await w.find(sel(TESTIDS.sendAmountNext)).trigger("click")
		expect(w.emitted("back")).toHaveLength(1)
		expect(w.emitted("next")).toHaveLength(1)
		w.unmount()
	})

	it("reports its own verdict on the field, and only its own", async () => {
		const w = step({ amount: "" })
		expect(w.emitted("update:valid")).toEqual([[false]])
		await w.setProps({ amount: "5" })
		expect(w.emitted("update:valid")).toEqual([[false], [true]])
		await w.setProps({ amount: "10.000001" })
		expect(w.emitted("update:valid")).toEqual([[false], [true], [false]])
		w.unmount()
	})

	it("a block decided above the step renders its reason and keeps Continue off, whatever the amount", () => {
		const w = step({ amount: "5", blockedReason: "The hub holds nothing to withdraw." })
		expect(w.find(sel(TESTIDS.sendAmountBlocked)).text()).toBe("The hub holds nothing to withdraw.")
		expect(w.find(sel(TESTIDS.sendAmountNext)).attributes("disabled")).toBeDefined()
		expect(w.emitted("update:valid")?.at(-1)).toEqual([false])
		w.unmount()
	})

	it("shows a sub-cent balance instead of rounding it to nothing", () => {
		const w = step({ balances: { l1: 5_000n } })
		expect(w.find(sel(TESTIDS.sendBalanceL1)).text()).toBe("Balance 0.005 USDC")
		w.unmount()
	})

	it("points the field at the complaint it just raised", async () => {
		const w = step({ amount: "1e6" })
		const input = w.find(sel(TESTIDS.sendAmountInput))
		expect(input.attributes("aria-invalid")).toBe("true")
		expect(input.attributes("aria-describedby")).toBe(w.find(sel(TESTIDS.sendAmountError)).attributes("id"))
		await w.setProps({ amount: "5" })
		expect(w.find(sel(TESTIDS.sendAmountInput)).attributes("aria-invalid")).toBeUndefined()
		expect(w.find(sel(TESTIDS.sendAmountInput)).attributes("aria-describedby")).toBeUndefined()
		w.unmount()
	})

	it("says why token alone cannot go without gas held, and keeps Continue off until the intent moves", async () => {
		const w = step({ intent: "token", tokenOnlyBlocked: "Your Aztec account holds no gas yet." })
		expect(w.find(sel(TESTIDS.sendTokenOnlyBlocked)).text()).toContain("holds no gas")
		expect(w.find(sel(TESTIDS.sendTokenOnlyBlocked)).element.closest(ANNOUNCER)).not.toBeNull()
		expect(w.find(sel(TESTIDS.sendAmountNext)).attributes("disabled")).toBeDefined()
		expect(w.emitted("update:valid")?.at(-1)).toEqual([false])
		await w.setProps({ intent: "token+gas", gas: GAS })
		expect(w.find(sel(TESTIDS.sendTokenOnlyBlocked)).exists()).toBe(false)
		expect(w.find(sel(TESTIDS.sendAmountNext)).attributes("disabled")).toBeUndefined()
		w.unmount()
	})

	it("renders on the row's own symbol while the chain is still being read, with Continue off", async () => {
		const w = step({ token: { symbol: "USDC", decimals: 6 }, resolving: true, balances: {} })
		expect(w.find(sel(TESTIDS.sendAmountInput)).exists()).toBe(true)
		expect(w.text()).toContain("USDC")
		expect(w.text()).not.toMatch(/reading|loading|checking/i)
		expect(w.find(sel(TESTIDS.sendAmountNext)).attributes("disabled")).toBeDefined()
		await w.setProps({ resolving: false, balances: { l1: 10_000_000n } })
		expect(w.find(sel(TESTIDS.sendAmountNext)).attributes("disabled")).toBeUndefined()
		w.unmount()
	})

	it("the privacy label says what the switch's state means, while the switch keeps its name", async () => {
		const w = step()
		const toggle = () => w.find(sel(TESTIDS.sendPrivateToggle))
		const label = () => w.get(`#${toggle().attributes("aria-describedby")}`).text()
		expect(toggle().attributes("aria-label")).toBe("Private")
		expect(label()).toBe("Private — only you can see it")
		await w.setProps({ isPrivate: false })
		expect(toggle().attributes("aria-label")).toBe("Private")
		expect(label()).toBe("Public — visible on Aztec")
		w.unmount()
	})

	it("a private deposit's veil line hides the amount from others and shows what arrives to you", () => {
		const w = step({ intent: "token+gas", gas: GAS, amount: "5" })
		const line = w.get(sel(TESTIDS.sendPrivacyVeil))
		expect(line.text()).toContain("you see 3.00 USDC")
		expect(line.get('[role="img"]').attributes("aria-label")).toBe("hidden amount")
		w.unmount()
	})

	it("has no veil line when public, on an exit, or for a gas-only send", () => {
		const cases: Partial<Props>[] = [
			{ isPrivate: false },
			{ direction: "l2-to-l1", balances: { l2Private: 10_000_000n } },
			{ intent: "gas", gas: GAS },
		]
		for (const over of cases) {
			const w = step(over)
			expect(w.find(sel(TESTIDS.sendPrivacyVeil)).exists()).toBe(false)
			w.unmount()
		}
	})
	describe("at phone width", () => {
		afterEach(() => vi.unstubAllGlobals())

		function phoneStep(over: Partial<Props> = {}) {
			vi.stubGlobal("matchMedia", (query: string) => ({
				matches: query === "(max-width: 760px)",
				media: query,
				addEventListener() {},
				removeEventListener() {},
			}))
			return step({ intent: "token+gas", gas: GAS, ...over })
		}
		const breakdown = (w: ReturnType<typeof step>) => w.get(sel(TESTIDS.sendGasBreakdown))
		const hint = (w: ReturnType<typeof step>) => w.get(sel(TESTIDS.sendGasDisclosure))

		it("folds the breakdown behind the selected row's hint, which opens it", async () => {
			const w = phoneStep()
			expect(hint(w).attributes("aria-controls")).toBe(breakdown(w).attributes("id"))
			expect(breakdown(w).isVisible()).toBe(false)
			expect(hint(w).attributes("aria-expanded")).toBe("false")
			await hint(w).trigger("click")
			expect(breakdown(w).isVisible()).toBe(true)
			expect(hint(w).attributes("aria-expanded")).toBe("true")
			w.unmount()
		})

		it("an error or a cap note holds the breakdown open without a tap", () => {
			const capped = { ...GAS, capped: "half" } as GasLegPlan
			for (const over of [{ gasError: "That amount cannot buy gas." }, { gas: capped }]) {
				const w = phoneStep(over)
				expect(breakdown(w).isVisible()).toBe(true)
				expect(hint(w).attributes("aria-expanded")).toBe("true")
				w.unmount()
			}
		})

		it("taps on a held breakdown change nothing: once the hold ends it folds, as before the taps", async () => {
			const w = phoneStep({ gas: { ...GAS, capped: "half" } as GasLegPlan })
			expect(hint(w).attributes("aria-disabled")).toBe("true")
			await hint(w).trigger("click")
			await hint(w).trigger("click")
			await hint(w).trigger("click")
			await w.setProps({ gas: GAS })
			expect(hint(w).attributes("aria-disabled")).toBeUndefined()
			expect(breakdown(w).isVisible()).toBe(false)
			expect(hint(w).attributes("aria-expanded")).toBe("false")
			w.unmount()
		})

		it("a capped gas-only plan has no cap note, so its breakdown stays folded until tapped", async () => {
			const w = phoneStep({ intent: "gas", gas: { ...GAS, capped: "half" } as GasLegPlan })
			expect(breakdown(w).isVisible()).toBe(false)
			expect(hint(w).attributes("aria-expanded")).toBe("false")
			await hint(w).trigger("click")
			expect(breakdown(w).isVisible()).toBe(true)
			w.unmount()
		})
	})

	it("a desktop shows the breakdown with no hint button", () => {
		const w = step({ intent: "token+gas", gas: GAS })
		expect(w.get(sel(TESTIDS.sendGasBreakdown)).isVisible()).toBe(true)
		expect(w.find(sel(TESTIDS.sendGasDisclosure)).exists()).toBe(false)
		w.unmount()
	})
})
