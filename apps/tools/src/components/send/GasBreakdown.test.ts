import { mount } from "@vue/test-utils"
import { describe, expect, it } from "vitest"
import type { GasLegPlan, ResolvedToken } from "@/lib/send-model"
import { TESTIDS } from "@/lib/testids"
import GasBreakdown from "./GasBreakdown.vue"

const sel = (t: string) => `[data-testid="${t}"]`

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

function gasPlan(over: Partial<GasLegPlan> = {}): GasLegPlan {
	return {
		fuelAmount: 2_000_000n,
		fuelFj: 300_000_000_000_000_000n,
		quote: 300_000_000_000_000_000n,
		minFuelOutput: 285_000_000_000_000_000n,
		route: { path: [], zeroForOnes: [] },
		capped: null,
		...over,
	} as GasLegPlan
}

type Props = {
	token: ResolvedToken
	amount: bigint
	intent: "token+gas" | "gas"
	gas: GasLegPlan | null
	txTarget: number
	fjPerTx: bigint | null
	setAside?: bigint | null
	loading: boolean
	error: string | null
}

function breakdown(over: Partial<Props> = {}) {
	return mount(GasBreakdown, {
		props: {
			token: TOKEN,
			amount: 10_000_000n,
			intent: "token+gas",
			gas: gasPlan(),
			txTarget: 20,
			fjPerTx: 100_000_000_000_000_000n,
			loading: false,
			error: null,
			...over,
		},
	})
}

describe("GasBreakdown", () => {
	it("says what arrives as the token and what arrives as gas, and from how much", () => {
		const w = breakdown()
		expect(w.find(sel(TESTIDS.sendGasBreakdownToken)).text()).toContain("8.00 USDC")
		expect(w.find(sel(TESTIDS.sendGasBreakdownFuel)).text()).toContain("≈ 0.3 FJ")
		expect(w.find(sel(TESTIDS.sendGasShare)).text()).toBe("from 2.00 USDC")
		w.unmount()
	})

	it("lists what arrives as term and value rows of one list, under pixel-glyph nudges", () => {
		const w = breakdown()
		const rows = w.findAll("dl > div")
		expect(rows.map((r) => r.attributes("data-testid"))).toEqual([TESTIDS.sendGasBreakdownToken, TESTIDS.sendGasBreakdownFuel])
		expect(rows.map((r) => r.find("dt").text())).toEqual(["Arrives as USDC", "Arrives as gas"])
		for (const id of [TESTIDS.sendGasTxFewer, TESTIDS.sendGasTxMore]) {
			const nudge = w.find(sel(id))
			expect(nudge.find("svg").exists()).toBe(true)
			expect(nudge.text()).toBe("")
		}
		w.unmount()
	})

	it("never renders a negative remainder when the slice covers everything", () => {
		const w = breakdown({ amount: 1_000_000n })
		expect(w.find(sel(TESTIDS.sendGasBreakdownToken)).text()).toContain("0.00 USDC")
		w.unmount()
	})

	it("shows the gas value as pending while the slice is being sized", () => {
		const w = breakdown({ loading: true })
		expect(w.find(sel(TESTIDS.sendGasBreakdownFuel)).text()).toContain("—")
		expect(w.find(sel(TESTIDS.sendGasBreakdown)).attributes("data-loading")).toBeDefined()
		w.unmount()
	})

	it("renders without a plan instead of guessing one", () => {
		const w = breakdown({ gas: null })
		expect(w.find(sel(TESTIDS.sendGasShare)).text()).toContain("—")
		expect(w.find(sel(TESTIDS.sendGasBreakdownToken)).text()).toContain("10.00 USDC")
		w.unmount()
	})

	it("surfaces the gas error, stripped of bidi controls and capped", () => {
		const w = breakdown({ error: `The quote failed: ‮${"x".repeat(500)}` })
		const shown = w.find(".err").text()
		expect(shown).toMatch(/^The quote failed: x+…$/)
		expect(Array.from(shown)).toHaveLength(241)
		w.unmount()
	})

	it("the stepper shows the target and nudges it one transaction at a time", async () => {
		const w = breakdown({ txTarget: 3 })
		expect((w.find(sel(TESTIDS.sendGasTxTarget)).element as HTMLInputElement).value).toBe("3")
		expect(w.find(sel(TESTIDS.sendGasBreakdown)).text()).toContain("transactions")
		await w.find(sel(TESTIDS.sendGasTxMore)).trigger("click")
		await w.find(sel(TESTIDS.sendGasTxFewer)).trigger("click")
		expect(w.emitted("update:txTarget")).toEqual([[4], [2]])
		w.unmount()
	})

	it("never steps below one transaction", async () => {
		const w = breakdown({ txTarget: 1 })
		expect(w.find(sel(TESTIDS.sendGasTxFewer)).attributes("disabled")).toBeDefined()
		expect((w.find(sel(TESTIDS.sendGasTxTarget)).element as HTMLInputElement).value).toBe("1")
		expect(w.find(sel(TESTIDS.sendGasBreakdown)).text()).not.toContain("transactions")
		w.unmount()
	})

	it("a typed target lands on change, as a number", async () => {
		const w = breakdown()
		await w.find(sel(TESTIDS.sendGasTxTarget)).setValue("12")
		expect(w.emitted("update:txTarget")).toEqual([[12]])
		w.unmount()
	})

	it("ignores a half-typed or out-of-range target rather than sizing for it, and the field snaps back", async () => {
		const w = breakdown()
		const field = w.find(sel(TESTIDS.sendGasTxTarget))
		for (const junk of ["", "0", "5000"]) {
			await field.setValue(junk)
			expect((field.element as HTMLInputElement).value).toBe("20")
		}
		expect(w.emitted("update:txTarget")).toBeUndefined()
		w.unmount()
	})

	it("explains nothing about how the gas is sized — the two arrival lines are the whole card", () => {
		const w = breakdown({ txTarget: 3 })
		expect(w.text()).not.toMatch(/sized|floor|at least|swapped/i)
		expect(w.findAll("button")).toHaveLength(2)
		w.unmount()
	})

	it("never rounds a small slice away — the split shown is the one signed", () => {
		const w = breakdown({ amount: 6_000n, gas: gasPlan({ fuelAmount: 1_000n, quote: 5_000n, minFuelOutput: 4_500n }) })
		expect(w.find(sel(TESTIDS.sendGasBreakdownToken)).text()).toContain("0.005 USDC")
		expect(w.find(sel(TESTIDS.sendGasShare)).text()).toContain("0.001 USDC")
		expect(w.find(sel(TESTIDS.sendGasBreakdownFuel)).text()).toContain("0.000000000000005 FJ")
		w.unmount()
	})

	it("says when the slice was capped, right under the lines", () => {
		const w = breakdown({ gas: gasPlan({ capped: "half" }) })
		expect(w.find(sel(TESTIDS.sendGasBreakdown)).attributes("data-capped")).toBe("half")
		expect(w.find(sel(TESTIDS.sendGasBreakdown)).text()).toContain("capped at half")
		w.unmount()
	})

	it("a gas-only send shows only what arrives and what it is enough for", () => {
		const w = breakdown({ intent: "gas", amount: 2_000_000n, gas: gasPlan({ quote: 1_050_000_000_000_000_000n }) })
		expect(w.find(sel(TESTIDS.sendGasBreakdown)).attributes("data-intent")).toBe("gas")
		expect(w.find(sel(TESTIDS.sendGasBreakdownFuel)).text()).toContain("≈ 1.05 FJ")
		expect(w.find(sel(TESTIDS.sendGasEnough)).text()).toContain("≈ 10 transactions")
		expect(w.find(sel(TESTIDS.sendGasBreakdownToken)).exists()).toBe(false)
		expect(w.find(sel(TESTIDS.sendGasTxTarget)).exists()).toBe(false)
		w.unmount()
	})

	it("a gas-only send counts only what remains after the claim's set-aside", () => {
		const w = breakdown({ intent: "gas", gas: gasPlan({ quote: 1_050_000_000_000_000_000n }), setAside: 400_000_000_000_000_000n })
		expect(w.find(sel(TESTIDS.sendGasEnough)).text()).toContain("≈ 6 transactions")
		w.unmount()
		const spent = breakdown({ intent: "gas", gas: gasPlan({ quote: 10n ** 17n }), setAside: 4n * 10n ** 17n })
		expect(spent.find(sel(TESTIDS.sendGasEnough)).exists()).toBe(false)
		spent.unmount()
		const unpriced = breakdown({ intent: "gas", gas: gasPlan({ quote: 1_050_000_000_000_000_000n }), setAside: null })
		expect(unpriced.find(sel(TESTIDS.sendGasEnough)).exists(), "an unpriced set-aside states no count").toBe(false)
		unpriced.unmount()
	})

	it("a gas-only send on a network with no per-transaction budget states no count", () => {
		const w = breakdown({ intent: "gas", fjPerTx: null })
		expect(w.find(sel(TESTIDS.sendGasEnough)).exists()).toBe(false)
		w.unmount()
	})
})
