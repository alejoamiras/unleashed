import { describe, expect, it } from "vitest"
import { humanizeWalletError, isUserRejection } from "./wallet-errors"

describe("isUserRejection (explicit signals ONLY)", () => {
	it("EIP-1193 code 4001, flat or nested in the cause chain", () => {
		expect(isUserRejection({ code: 4001, message: "User rejected the request." })).toBe(true)
		expect(isUserRejection(new Error("outer", { cause: { code: 4001 } }))).toBe(true)
	})

	it("viem UserRejectedRequestError by name anywhere in the chain", () => {
		const viemish = Object.assign(new Error("User rejected the request."), { name: "UserRejectedRequestError" })
		expect(isUserRejection(viemish)).toBe(true)
		expect(isUserRejection(new Error("wrap", { cause: viemish }))).toBe(true)
	})

	it("Aztec wallet explicit decline wordings", () => {
		expect(isUserRejection(new Error("Transaction rejected by user"))).toBe(true)
		expect(isUserRejection(new Error("Capability denied by user"))).toBe(true)
	})

	it("AMBIGUOUS failures are NOT rejections - RPC outages, timeouts, generic errors", () => {
		expect(isUserRejection(new Error("fetch failed"))).toBe(false)
		expect(isUserRejection(new Error("nonce too low"))).toBe(false)
		expect(isUserRejection({ code: -32603, message: "Internal JSON-RPC error." })).toBe(false)
		expect(isUserRejection(new Error("HTTP request failed: 503"))).toBe(false)
		expect(isUserRejection(undefined)).toBe(false)
		expect(isUserRejection("rejected")).toBe(false) // strings aren't provider errors
	})
})

describe("humanizeWalletError", () => {
	it("translates the wallet window timeout; passes unknown messages through", () => {
		expect(humanizeWalletError("Timed out waiting for window")).toMatch(/confirmation window timed out.*retry/i)
		expect(humanizeWalletError("nonce too low")).toBe("nonce too low")
	})
})
