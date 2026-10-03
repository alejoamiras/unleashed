import { Fr } from "@aztec-labs/aztec.js/fields"
import { TxHash } from "@aztec-labs/aztec.js/tx"
import { describe, expect, it } from "vitest"
import { classifyClaimReceipt, isWellFormedTxHash } from "./claim-receipt"

describe("isWellFormedTxHash", () => {
	it("accepts exactly 0x + 64 hex digits that the parser also accepts — parity with TxHash.fromString, not just shape", () => {
		expect(isWellFormedTxHash(`0x${"00".repeat(31)}ab`)).toBe(true)
		expect(isWellFormedTxHash(`0x${"00".repeat(31)}AB`)).toBe(true)
		// A tx hash is a field element: these are 32 bytes of hex the parser rejects.
		expect(isWellFormedTxHash(`0x${"ff".repeat(32)}`)).toBe(false)
		expect(isWellFormedTxHash(`0x${Fr.MODULUS.toString(16).padStart(64, "0")}`)).toBe(false)
		expect(isWellFormedTxHash(`0x${(Fr.MODULUS - 1n).toString(16).padStart(64, "0")}`)).toBe(true)
		// …and these are values the parser accepts that are not tx hashes.
		expect(TxHash.fromString("0x01")).toBeTruthy()
		expect(isWellFormedTxHash("0x01")).toBe(false)
		for (const bad of [
			"",
			"0x",
			"0xabc",
			`0x${"ab".repeat(31)}`,
			`0x${"ab".repeat(33)}`,
			`${"ab".repeat(32)}`,
			`0x${"zz".repeat(32)}`,
			`0x${"ab".repeat(32)} `,
		]) {
			expect(isWellFormedTxHash(bad), bad).toBe(false)
		}
	})
})

describe("classifyClaimReceipt", () => {
	it("checkpointed/proven/finalized with clean execution reads success", () => {
		expect(classifyClaimReceipt({ status: "CHECKPOINTED", executionResult: "SUCCESS" })).toBe("success")
		expect(classifyClaimReceipt({ status: "proven" })).toBe("success")
		expect(classifyClaimReceipt({ status: "finalized" })).toBe("success")
	})

	it("an included-but-reverted receipt reads reverted (revert lives in executionResult)", () => {
		expect(classifyClaimReceipt({ status: "checkpointed", executionResult: "APP_LOGIC_REVERTED" })).toBe("reverted")
	})

	it("a PROPOSED receipt reads proposed - distinct from pending, never included", () => {
		expect(classifyClaimReceipt({ status: "PROPOSED" })).toBe("proposed")
	})

	it("dropped and reverted statuses pass through", () => {
		expect(classifyClaimReceipt({ status: "dropped" })).toBe("dropped")
		expect(classifyClaimReceipt({ status: "reverted" })).toBe("reverted")
	})

	it("missing/unknown receipts read pending", () => {
		expect(classifyClaimReceipt(undefined)).toBe("pending")
		expect(classifyClaimReceipt({ status: "pending" })).toBe("pending")
	})
})
