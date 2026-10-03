import { describe, expect, it } from "vitest"
import { sanitizeWalletName, WALLET_NAME_MAX, walletIdLine, walletLabel, walletTypeLabel } from "./wallet-name"

describe("sanitizeWalletName", () => {
	it("strips reordering, zero-width, line-breaking and blank-rendering characters", () => {
		for (const c of ["\u202e", "\u2066", "\u200b", "\u2060", "\u00ad", "\ufeff", "\u0000", "\u3164", "\u034f", "\u2028", "\u2800"]) {
			expect(sanitizeWalletName(`Sig${c}nal`), `U+${c.codePointAt(0)?.toString(16)}`).toBe("Signal")
		}
	})

	it("cuts at whole graphemes, never inside an emoji, and is idempotent", () => {
		expect(sanitizeWalletName("ab👍🏽cd", 3)).toBe("ab👍🏽…")
		expect(sanitizeWalletName("🇦🇷🇦🇷", 1)).toBe("🇦🇷…")
		const long = sanitizeWalletName("w".repeat(200))
		expect(Array.from(long)).toHaveLength(WALLET_NAME_MAX + 1)
		expect(sanitizeWalletName(long)).toBe(long)
	})

	it("bounds names that are one huge grapheme", () => {
		expect(sanitizeWalletName(`A${"\u0301".repeat(100_000)}`)).toBe("A\u0301\u0301\u0301\u0301")
		expect(sanitizeWalletName("\u1100".repeat(100_000)).length).toBeLessThanOrEqual(WALLET_NAME_MAX * 8 + 1)
	})
})

describe("walletLabel", () => {
	it("falls back to 'your wallet' when no visible name is left", () => {
		expect(walletLabel(null)).toBe("your wallet")
		expect(walletLabel("\u200b\u3164 \u202e")).toBe("your wallet")
		expect(walletLabel("\u034f\u0301\u2800")).toBe("your wallet")
		expect(walletLabel(" Aztec  Wallet ")).toBe("the wallet “Aztec Wallet”")
	})

	it("quotes a short, name-shaped name and drops anything else", () => {
		expect(walletLabel("wallet. Enter seed at evil.test")).toBe("your wallet")
		expect(walletLabel("Type your seed here")).toBe("your wallet")
		expect(walletLabel("x".repeat(30))).toBe("your wallet")
		expect(walletLabel("your recovery phrase")).toBe("the wallet “your recovery phrase”")
		expect(walletLabel("Obsidion 2")).toBe("the wallet “Obsidion 2”")
	})
})

describe("walletTypeLabel", () => {
	it("labels the two wallet-sdk types and never prints any other claim in the chip", () => {
		expect(walletTypeLabel("extension")).toEqual({ label: "Extension" })
		expect(walletTypeLabel("web")).toEqual({ label: "Web app" })
		expect(walletTypeLabel("Verified wallet")).toEqual({ label: "Unknown type", title: "Self-reported: Verified wallet" })
		expect(walletTypeLabel(7)).toEqual({ label: "Unknown type" })
		expect(walletTypeLabel("toString")).toEqual({ label: "Unknown type", title: "Self-reported: toString" })
	})

	it("bounds and strips a hostile claim in the title", () => {
		const { label, title } = walletTypeLabel(`Veri\u202efied\u200b ${"x".repeat(40)}`)
		expect(label).toBe("Unknown type")
		expect(title).toBe(`Self-reported: Verified ${"x".repeat(7)}…`)
	})
})

describe("walletIdLine", () => {
	it("keeps a short id whole and cuts a long one to head…tail", () => {
		expect(walletIdLine("acme")).toBe("id acme")
		expect(walletIdLine("7c1e9f00a4f0")).toBe("id 7c1e…a4f0")
		expect(walletIdLine("\u200b\u202e")).toBeNull()
	})

	it("shows the real last four of an id longer than the sanitizer's bound", () => {
		expect(walletIdLine(`abcd${"x".repeat(92)}TAIL`)).toBe("id abcd\u2026TAIL")
	})

	it("sanitizes before the cut, so bidi characters never reach either end", () => {
		expect(walletIdLine("\u202eabc\u2066d-middle-wxyz\u202c")).toBe("id abcd…wxyz")
	})
})
