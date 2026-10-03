import { describe, expect, it } from "vitest"
import {
	formatAmount,
	formatBigInt,
	formatCompact,
	formatDisplayAmount,
	formatStoredAmount,
	parseAmount,
	parseAmountStrict,
	toDecimalString,
	trimAddress,
} from "./format"

describe("formatCompact", () => {
	it("groups thousands and drops trailing zeros", () => {
		expect(formatCompact(1_000_000_000n, 6)).toBe("1,000")
		expect(formatCompact(10_700_000_000_000_000_000n, 18)).toBe("10.7")
		expect(formatCompact(0n, 18)).toBe("0")
	})

	it("keeps a whole number's zeros — only a fraction's are padding", () => {
		expect(formatCompact(100n, 0)).toBe("100")
		expect(formatCompact(1_000_000n, 6, 0)).toBe("1")
		expect(formatCompact(10_000_000n, 6, 0)).toBe("10")
	})

	it("cuts the fraction to the requested places without rounding", () => {
		expect(formatCompact(1_239_999n, 6)).toBe("1.23")
		expect(formatCompact(1_239_999n, 6, 4)).toBe("1.2399")
	})

	it("never rounds a tiny value away — it shows the leading significant digits", () => {
		expect(formatCompact(5_000n, 18)).toBe("0.000000000000005")
		expect(formatCompact(4_500n, 18)).toBe("0.0000000000000045")
		expect(formatCompact(5_000n, 6)).toBe("0.005")
	})
})

describe("formatBigInt", () => {
	it("formats zero with the requested display places", () => {
		expect(formatBigInt(0n, 6)).toBe("0.00")
		expect(formatBigInt(0n, 18, 4)).toBe("0.0000")
	})

	it("formats 1,000 USDC (decimals=6) correctly", () => {
		expect(formatBigInt(1_000_000_000n, 6)).toBe("1,000.00")
	})

	it("formats 1 ETH (decimals=18) correctly", () => {
		expect(formatBigInt(1_000_000_000_000_000_000n, 18)).toBe("1.00")
	})

	it("truncates fractional digits beyond displayPlaces (no rounding)", () => {
		expect(formatBigInt(1_234_567n, 6, 2)).toBe("1.23")
	})

	it("preserves fractional zeros when 0 < value < 1", () => {
		expect(formatBigInt(50_000n, 6, 2)).toBe("0.05")
	})
})

describe("trimAddress", () => {
	const long = "0x12345678901234567890123456789012345678901234567890123456789012ab"

	it("shortens a long address using default head/tail", () => {
		expect(trimAddress(long)).toBe(`${long.slice(0, 6)}…${long.slice(-4)}`)
	})

	it("returns an em-dash for empty input", () => {
		expect(trimAddress("")).toBe("-")
	})

	it("returns the original when shorter than head+tail+2", () => {
		expect(trimAddress("0x123")).toBe("0x123")
	})
})

describe("parseAmount (BigInt-safe fixed-decimal parsing)", () => {
	it("parses whole + fractional inputs at 6 and 18 decimals", () => {
		expect(parseAmount("100", 6)).toBe(100_000_000n)
		expect(parseAmount("1.5", 18)).toBe(1_500_000_000_000_000_000n)
		expect(parseAmount("0.000001", 6)).toBe(1n)
	})

	it("18-dec precision survives where Number() dies (>2^53 base units)", () => {
		expect(parseAmount("9007199254.740993", 18)).toBe(9_007_199_254_740_993_000_000_000_000n)
	})

	it("excess fractional digits TRUNCATE (never round up a spend)", () => {
		expect(parseAmount("1.9999999", 6)).toBe(1_999_999n)
	})

	it("junk, empty, and bare-dot inputs parse to 0n", () => {
		expect(parseAmount("abc", 6)).toBe(0n)
		expect(parseAmount("", 18)).toBe(0n)
		expect(parseAmount(".", 18)).toBe(0n)
		expect(parseAmount("1.2.3", 6)).toBe(0n)
		expect(parseAmount("-5", 6)).toBe(0n)
	})
})

describe("parseAmountStrict (field-grade parsing)", () => {
	it("parses the plain decimals parseAmount parses", () => {
		expect(parseAmountStrict("100", 6)).toBe(100_000_000n)
		expect(parseAmountStrict(" 1.5 ", 18)).toBe(1_500_000_000_000_000_000n)
		expect(parseAmountStrict("0", 6)).toBe(0n)
	})

	it("refuses more places than the token has instead of truncating them", () => {
		expect(parseAmountStrict("1.9999999", 6)).toBeNull()
		expect(parseAmountStrict("1.999999", 6)).toBe(1_999_999n)
	})

	it("refuses everything that is not a plain decimal number", () => {
		expect(parseAmountStrict("abc", 6)).toBeNull()
		expect(parseAmountStrict("", 6)).toBeNull()
		expect(parseAmountStrict("1.", 6)).toBeNull()
		expect(parseAmountStrict(".5", 6)).toBeNull()
		expect(parseAmountStrict("-5", 6)).toBeNull()
		expect(parseAmountStrict("1e6", 6)).toBeNull()
		expect(parseAmountStrict("5", -1)).toBeNull()
	})
})

describe("toDecimalString", () => {
	it("drops grouping and trailing zeros so the text can be typed back", () => {
		expect(toDecimalString(12_345_678n, 6)).toBe("12.345678")
		expect(toDecimalString(1_500_000n, 6)).toBe("1.5")
		expect(toDecimalString(1_000_000n, 6)).toBe("1")
		expect(toDecimalString(0n, 18)).toBe("0")
	})

	it("round-trips at full precision", () => {
		const value = 9_007_199_254_740_993_000_000_000_001n
		expect(parseAmountStrict(toDecimalString(value, 18), 18)).toBe(value)
	})
})

describe("formatDisplayAmount", () => {
	it.each([
		[250_000_000n, 6, "250.00"],
		[1_000_000_000n, 6, "1,000.00"],
		[5_000n, 6, "0.005"],
		[1n, 18, "0.000000000000000001"],
		[0n, 6, "0.00"],
		[1000n, 0, "1,000"],
		[125n, 1, "12.5"],
	])("%s at %i decimals reads %s: grouped, padded, never cut", (value, decimals, text) => {
		expect(formatDisplayAmount(value, decimals)).toBe(text)
	})
})

describe("formatAmount", () => {
	it.each([
		[50_000_000n, 6, "50.00"],
		[1_005_000n, 6, "1.00"],
		[10_000n, 6, "0.01"],
		[9_999n, 6, "0.0099"],
		[5_000n, 6, "0.005"],
		[12_345n, 9, "0.000012"],
		[69_000_000_000_000n, 18, "0.000069"],
		[0n, 18, "0.00"],
		[7n, 2, "0.07"],
		[7n, 0, "7"],
	])("%s at %s decimals reads %s: two places from 0.01 up, two significant digits below, never zero", (value, decimals, text) => {
		expect(formatAmount(value, decimals)).toBe(text)
	})
})

describe("formatStoredAmount", () => {
	it("formats a possible chain amount and dashes anything else — a 79-digit string never reaches BigInt", () => {
		expect(formatStoredAmount("1000000", 6)).toBe("1.00")
		expect(formatStoredAmount("5000", 6)).toBe("0.005")
		expect(formatStoredAmount("9".repeat(78), 18)).not.toBe("—")
		expect(formatStoredAmount("9".repeat(79), 18)).toBe("—")
		expect(formatStoredAmount("12abc", 6)).toBe("—")
		expect(formatStoredAmount("", 6)).toBe("—")
	})
})
