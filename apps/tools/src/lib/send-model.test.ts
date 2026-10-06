import { describe, expect, it } from "vitest"
import { tokenRemainder } from "./send-model"

describe("tokenRemainder", () => {
	it("is the amount less the gas slice", () => {
		expect(tokenRemainder(250_000_000n, { fuelAmount: 2_400_000n })).toBe(247_600_000n)
	})

	it("is 0 when the slice covers the whole amount, never negative", () => {
		expect(tokenRemainder(1_000n, { fuelAmount: 1_000n })).toBe(0n)
		expect(tokenRemainder(1_000n, { fuelAmount: 1_001n })).toBe(0n)
	})

	it("is the whole amount without a gas leg", () => {
		expect(tokenRemainder(1_000n, undefined)).toBe(1_000n)
		expect(tokenRemainder(1_000n, null)).toBe(1_000n)
	})
})
