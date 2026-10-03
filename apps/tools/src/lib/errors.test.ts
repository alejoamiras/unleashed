import { describe, expect, it } from "vitest"
import { normalizeError, userMessage, walletErrorCodeOf } from "./errors"

/** An extension transport throws `new Error(JSON.stringify(envelope))` — one JSON level. */
const extensionShape = (code: string) => new Error(JSON.stringify({ code: -32602, message: "x", data: { walletErrorCode: code } }))
/** The wallet-sdk iframe transport reduces the throw to its message STRING, then JSON-encodes that
 *  string again — so the dApp sees a JSON string, two levels deep. */
const iframeShape = (code: string) =>
	new Error(JSON.stringify(JSON.stringify({ code: -32602, message: "x", data: { walletErrorCode: code } })))

describe("wallet-error envelope", () => {
	it("maps PXE_STALE_ANCHOR to chain-desync from both transport shapes", () => {
		expect(normalizeError(extensionShape("PXE_STALE_ANCHOR")).category).toBe("chain-desync")
		expect(normalizeError(iframeShape("PXE_STALE_ANCHOR")).category).toBe("chain-desync")
	})

	it("maps CONTRACT_NOT_REGISTERED to contract-not-registered from both shapes", () => {
		expect(normalizeError(extensionShape("CONTRACT_NOT_REGISTERED")).category).toBe("contract-not-registered")
		expect(normalizeError(iframeShape("CONTRACT_NOT_REGISTERED")).category).toBe("contract-not-registered")
	})

	it("a non-JSON message still hits the substring rules", () => {
		expect(normalizeError(new Error("fetch failed: timeout after 30s")).category).toBe("network")
	})

	it("a JSON message without a walletErrorCode falls through to the substring rules", () => {
		expect(normalizeError(new Error(JSON.stringify({ code: -32000, message: "transaction reverted" }))).category).toBe("tx-reverted")
	})

	it("an unknown walletErrorCode falls through, not to chain-desync", () => {
		expect(normalizeError(extensionShape("SOMETHING_ELSE")).category).toBe("unknown")
	})

	it("a code that names an inherited object property does not resolve to a bogus category", () => {
		for (const evil of ["toString", "constructor", "__proto__", "hasOwnProperty"]) {
			const out = normalizeError(extensionShape(evil))
			expect(out.category).toBe("unknown")
			expect(typeof out.message).toBe("string")
		}
	})

	it("does not decode a third level of nesting", () => {
		const tripled = new Error(JSON.stringify(JSON.stringify(JSON.stringify({ data: { walletErrorCode: "PXE_STALE_ANCHOR" } }))))
		expect(walletErrorCodeOf(tripled)).toBeUndefined()
	})

	it("walletErrorCodeOf returns the code, or undefined for a plain error", () => {
		expect(walletErrorCodeOf(extensionShape("PXE_STALE_ANCHOR"))).toBe("PXE_STALE_ANCHOR")
		expect(walletErrorCodeOf(iframeShape("CONTRACT_NOT_REGISTERED"))).toBe("CONTRACT_NOT_REGISTERED")
		expect(walletErrorCodeOf(new Error("plain"))).toBeUndefined()
		expect(walletErrorCodeOf("not an error")).toBeUndefined()
	})
})

describe("normalizeError", () => {
	it("classifies EIP-1193 code=4001 as user-rejected", () => {
		const out = normalizeError({ code: 4001, message: "User rejected the request" })
		expect(out.category).toBe("user-rejected")
		expect(out.message).toBe("Rejected in wallet.")
	})

	it("classifies textual 'denied by user' as user-rejected", () => {
		const out = normalizeError(new Error("Request denied by user"))
		expect(out.category).toBe("user-rejected")
	})

	it("classifies 'Existing nullifier' as account-uninitialized", () => {
		const out = normalizeError(new Error("Existing nullifier on tx submission"))
		expect(out.category).toBe("account-uninitialized")
		expect(out.message).toMatch(/account isn't deployed/i)
	})

	it("classifies 'transaction reverted' as tx-reverted", () => {
		const out = normalizeError(new Error("Transaction reverted on-chain"))
		expect(out.category).toBe("tx-reverted")
	})

	it("classifies fetch / timeout errors as network", () => {
		const out = normalizeError(new Error("fetch failed: timeout after 30s"))
		expect(out.category).toBe("network")
		expect(out.message).toMatch(/alpha-testnet is not responding/i)
	})

	it("falls back to 'unknown' for unrecognized errors", () => {
		const out = normalizeError(new Error("Some completely opaque internal error"))
		expect(out.category).toBe("unknown")
	})
})

describe("userMessage", () => {
	it("unwraps a viem-style error to its cause, not the wrapper prose and version line", () => {
		const viemLike = Object.assign(
			new Error("An unknown RPC error occurred. Details: Connect your Ethereum wallet first. Version: viem@2.55.17"),
			{
				details: "Connect your Ethereum wallet first.",
				shortMessage: "An unknown RPC error occurred.",
			},
		)
		expect(userMessage(viemLike)).toBe("Connect your Ethereum wallet first.")
	})

	it("falls back to shortMessage, then the message, then the caller's default", () => {
		expect(userMessage(Object.assign(new Error("long"), { shortMessage: "Short." }))).toBe("Short.")
		expect(userMessage(new Error("plain"))).toBe("plain")
		expect(userMessage(new Error(""), "Could not read this token.")).toBe("Could not read this token.")
		expect(userMessage(undefined, "x")).toBe("x")
	})
})
