import { describe, expect, it } from "vitest"
import { type GasShareInput, proposeGasShare, signedMinFuelOutput } from "./gas-share"

/** 20 tx × 1e6 FJ = 2e7 FJ target; the dust quote says 1e3 token buys 4e3 FJ; 3% slippage. */
const BASE: GasShareInput = {
	amount: 100_000_000n,
	decimals: 6,
	fjPerTx: 1_000_000n,
	minFuelFj: 5_000_000n,
	rate: { probeIn: 1_000n, probeOut: 4_000n },
	slippageBps: 300,
}

describe("proposeGasShare", () => {
	it("sizes the swap from the tx target: 2e7 FJ × (1e3/4e3) ÷ 0.97", () => {
		expect(proposeGasShare(BASE)).toEqual({ fuelAmount: 5_154_640n, fuelFj: 20_000_000n, capped: null })
	})

	it("the floor signed for that input never lands below the target", () => {
		for (const slippageBps of [0, 1, 300, 2_500, 9_999]) {
			for (const rate of [BASE.rate, { probeIn: 3n, probeOut: 7n }, { probeIn: 999_999n, probeOut: 1n }]) {
				const { fuelAmount, fuelFj } = proposeGasShare({ ...BASE, amount: 10n ** 30n, slippageBps, rate })
				const quote = (fuelAmount * rate.probeOut) / rate.probeIn
				expect(
					signedMinFuelOutput(quote, slippageBps, 0n),
					`s=${slippageBps} rate=${rate.probeIn}/${rate.probeOut}`,
				).toBeGreaterThanOrEqual(fuelFj)
			}
		}
	})

	it("adds the registration cost when the token is not yet on L2", () => {
		expect(proposeGasShare({ ...BASE, fjRegister: 3_000_000n })).toEqual({
			fuelAmount: 5_927_836n,
			fuelFj: 23_000_000n,
			capped: null,
		})
	})

	it("committed fee ceilings come on top of the per-transaction gas and replace the registration's charge", () => {
		// A private claim forfeits the ceilings, so its registration's charge is inside them already.
		expect(proposeGasShare({ ...BASE, fjRegister: 3_000_000n, fjCeilings: 11_000_000n })).toEqual({
			fuelAmount: 7_989_691n,
			fuelFj: 31_000_000n,
			capped: null,
		})
	})

	it("reports 'min' when the floor, not the tx target, sized the buy", () => {
		expect(proposeGasShare({ ...BASE, minFuelFj: 50_000_000n })).toEqual({
			fuelAmount: 12_886_598n,
			fuelFj: 50_000_000n,
			capped: "min",
		})
	})

	it("clamps to half the deposit and says so", () => {
		expect(proposeGasShare({ ...BASE, amount: 10_000_000n })).toEqual({
			fuelAmount: 5_000_000n,
			fuelFj: 20_000_000n,
			capped: "half",
		})
	})

	it("rounds the input UP — a floored input buys less fuel than the target", () => {
		// 1000 FJ × 3/7, no slippage: 428.57… The floor (428) under-buys.
		const result = proposeGasShare({
			...BASE,
			amount: 100_000n,
			txTarget: 1,
			fjPerTx: 1_000n,
			minFuelFj: 0n,
			rate: { probeIn: 3n, probeOut: 7n },
			slippageBps: 0,
		})
		expect(result).toEqual({ fuelAmount: 429n, fuelFj: 1_000n, capped: null })
	})

	it("rejects inputs that would silently mis-size the swap", () => {
		expect(() => proposeGasShare({ ...BASE, amount: 0n })).toThrow(/amount/)
		expect(() => proposeGasShare({ ...BASE, rate: { probeIn: 1_000n, probeOut: 0n } })).toThrow(/probeOut/)
		expect(() => proposeGasShare({ ...BASE, txTarget: 0 })).toThrow(/txTarget/)
		expect(() => proposeGasShare({ ...BASE, slippageBps: 10_000 })).toThrow(/slippageBps/)
	})
})

describe("signedMinFuelOutput", () => {
	it("applies the slippage haircut to the quote", () => {
		expect(signedMinFuelOutput(1_000_000n, 300, 0n)).toBe(970_000n)
	})

	it("never signs below the claim minimum", () => {
		expect(signedMinFuelOutput(1_000_000n, 300, 990_000n)).toBe(990_000n)
		expect(signedMinFuelOutput(1n, 9_999, 42n)).toBe(42n)
	})

	it("rejects an empty quote and out-of-range slippage", () => {
		expect(() => signedMinFuelOutput(0n, 300, 1n)).toThrow(/quote/)
		expect(() => signedMinFuelOutput(100n, 10_000, 1n)).toThrow(/slippageBps/)
	})
})
