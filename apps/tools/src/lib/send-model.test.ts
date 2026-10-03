import { describe, expect, it } from "vitest"
import { type ChoiceHint, type ChoiceHintState, hintOf, type SendIntent, tokenRemainder } from "./send-model"

const hintText = (h: ChoiceHint): string => `${h.lead}${h.count ?? ""}${h.tail ?? ""}`

describe("hintOf", () => {
	const base: ChoiceHintState = { exit: false, txTarget: 2, gasBlock: null, tokenBlocked: false }
	it.each<[string, SendIntent, Partial<ChoiceHintState>, string]>([
		["token", "token", {}, "only the token"],
		["token + gas, one transaction", "token+gas", { txTarget: 1 }, "gas for 1 transaction"],
		["token + gas, two transactions", "token+gas", {}, "gas for 2 transactions"],
		["gas", "gas", {}, "all of it as gas"],
		["exit", "token", { exit: true }, "back to Ethereum"],
		["no route", "gas", { gasBlock: "no-route" }, "not for this token"],
		["route unavailable", "token+gas", { gasBlock: "unavailable" }, "can't check right now"],
		["token without held gas", "token", { tokenBlocked: true }, "needs gas first"],
	])("%s", (_, choice, over, text) => {
		expect(hintText(hintOf(choice, { ...base, ...over }))).toBe(text)
	})

	it("sets the transaction count apart so it renders as a figure", () => {
		expect(hintOf("token+gas", base)).toEqual({ lead: "gas for ", count: 2, tail: " transactions" })
	})
})

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
