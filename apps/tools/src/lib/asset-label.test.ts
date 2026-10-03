import type { BridgeJournalRecord } from "@unleashed/bridge-core"
import { describe, expect, it } from "vitest"
import { amountQualifier, assetDecimals, assetSymbol, displayAmountOf, displayAmountText, recordTokenBlock } from "./asset-label"

const TOKEN = { displaySymbol: "WBTC", decimals: 8 }

describe("asset-label", () => {
	it("fee-juice records render as Fee Juice (18-dec), never the token bridge asset", () => {
		expect(assetSymbol("fee-juice", false)).toBe("FJ")
		expect(assetSymbol("fee-juice", true)).toBe("Private FJ")
		expect(assetDecimals("fee-juice")).toBe(18)
	})

	it("a record with no token block of its own is named generically, never as some other token", () => {
		expect(assetSymbol("bridge-token", false)).toBe("TOKEN")
		expect(assetSymbol(undefined, true)).toBe("TOKEN")
		expect(assetDecimals("bridge-token")).toBe(18)
		expect(assetDecimals(undefined)).toBe(18)
	})

	it("a send's own token block names the asset", () => {
		expect(assetSymbol("bridge-token", false, TOKEN)).toBe("WBTC")
		expect(assetDecimals("bridge-token", TOKEN)).toBe(8)
	})

	it("a token block never overrides Fee Juice (a gas leg is 18-dec FJ whatever was sent)", () => {
		expect(assetSymbol("fee-juice", true, TOKEN)).toBe("Private FJ")
		expect(assetDecimals("fee-juice", TOKEN)).toBe(18)
	})

	it("recordTokenBlock reads schema-3 blocks and nothing else", () => {
		const send = { schema: 3, token: { displaySymbol: "WBTC", decimals: 8 } } as unknown as BridgeJournalRecord
		const gasOnly = { schema: 3, intent: "gas" } as unknown as BridgeJournalRecord
		const v1 = { schema: 2, token: { displaySymbol: "NOPE", decimals: 2 } } as unknown as BridgeJournalRecord
		expect(recordTokenBlock(send)).toEqual({ displaySymbol: "WBTC", decimals: 8 })
		expect(recordTokenBlock(gasOnly)).toBeUndefined()
		expect(recordTokenBlock(v1)).toBeUndefined()
	})

	describe("displayAmountOf: the amount every record surface shows", () => {
		const base = { id: "0xd", direction: "deposit", isPrivate: false, createdAt: 1, updatedAt: 1 }
		const gasOnly = (fuel?: object, isPrivate = false) =>
			({ ...base, schema: 3, intent: "gas", isPrivate, amount: "5000000", fuel }) as unknown as BridgeJournalRecord
		const E18 = "1000000000000000000"

		it("a gas-only send shows the gross Fee Juice it bought, never the paid token amount", () => {
			const d = displayAmountOf(gasOnly({ minOutput: "900", received: E18 }, true))
			expect(d).toEqual({ raw: E18, decimals: 18, atLeast: false, symbol: "Private FJ", gross: true })
			expect(displayAmountText(d)).toBe("1.00")
			expect(amountQualifier(d)).toBe("before claim fees")
		})

		it("before arrival a gas-only send shows at least its signed floor", () => {
			const d = displayAmountOf(gasOnly({ minOutput: E18 }))
			expect(d).toEqual({ raw: E18, decimals: 18, atLeast: true, symbol: "FJ", gross: true })
			expect(displayAmountText(d)).toBe("≥ 1.00")
			expect(displayAmountText(displayAmountOf(gasOnly({ minOutput: "69000000000000" })))).toBe("≥ 0.000069")
		})

		it("a gas-only send with no fuel block has no amount to show", () => {
			const d = displayAmountOf(gasOnly())
			expect(d.raw).toBe("")
			expect(displayAmountText(d)).toBe("—")
		})

		it("a token send and a schema-2 fee-juice record read their own amount, unqualified", () => {
			const send = { ...base, schema: 3, intent: "token", amount: "2500000", token: { displaySymbol: "USDC", decimals: 6 } }
			const token = displayAmountOf(send as unknown as BridgeJournalRecord)
			expect(token).toEqual({ raw: "2500000", decimals: 6, atLeast: false, symbol: "USDC", gross: false })
			expect(amountQualifier(token)).toBeNull()
			const gasRecord = { ...base, schema: 2, assetKind: "fee-juice", amount: E18, fuel: { minOutput: "1", received: "7" } }
			expect(displayAmountOf(gasRecord as unknown as BridgeJournalRecord)).toEqual({
				raw: E18,
				decimals: 18,
				atLeast: false,
				symbol: "FJ",
				gross: false,
			})
		})

		it("a hostile stored symbol comes back stripped and capped", () => {
			const send = { ...base, schema: 3, intent: "token", amount: "1", token: { displaySymbol: "US‮DC", decimals: 6 } }
			expect(displayAmountOf(send as unknown as BridgeJournalRecord).symbol).toBe("USDC")
		})
	})
})
