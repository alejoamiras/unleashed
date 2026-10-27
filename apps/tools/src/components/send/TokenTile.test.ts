import { mount } from "@vue/test-utils"
import { describe, expect, it } from "vitest"
import type { SelectableToken } from "@/lib/send-model"
import { TESTIDS } from "@/lib/testids"
import type { RowLook } from "./token-rows"
import TokenTile from "./TokenTile.vue"

const sel = (t: string) => `[data-testid="${t}"]`

const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"

function token(over: Partial<SelectableToken> = {}): SelectableToken {
	return {
		chainId: 1,
		address: USDC,
		symbol: "USDC",
		name: "USD Coin",
		decimals: 6,
		source: "manifest",
		logoKey: `1:${USDC}`,
		...over,
	} as SelectableToken
}

function tile(props: Partial<{ token: SelectableToken; selected: boolean; balance: bigint; decimals: number; look: RowLook }> = {}) {
	return mount(TokenTile, { props: { token: token(), selected: false, ...props } })
}

describe("TokenTile", () => {
	it("paints a manifest token in its brand colours", () => {
		const w = tile({ token: token({ chainId: 11155111, logoKey: `11155111:${USDC}` }) })
		const mark = w.find(sel(TESTIDS.sendTokenLogo))
		expect(mark.text()).toBe("US")
		expect(mark.attributes("style")).toContain("background: rgb(39, 117, 202)")
		expect(w.find(sel(TESTIDS.sendTokenMonogram)).exists()).toBe(false)
		w.unmount()
	})

	it("keeps a listed token claiming the same symbol grey", () => {
		const w = tile({
			token: token({ chainId: 11155111, source: "list", logoKey: "11155111:0x6666666666666666666666666666666666666666" }),
		})
		const mark = w.find(sel(TESTIDS.sendTokenMonogram))
		expect(mark.text()).toBe("US")
		expect(mark.attributes("style")).toBeUndefined()
		expect(w.find(sel(TESTIDS.sendTokenLogo)).exists()).toBe(false)
		w.unmount()
	})

	it("emits select when clicked", async () => {
		const w = tile()
		await w.find(sel(TESTIDS.sendTokenTile)).trigger("click")
		expect(w.emitted("select")).toHaveLength(1)
		w.unmount()
	})

	it("reports selection to assistive tech and to CSS", () => {
		const w = tile({ selected: true })
		const root = w.find(sel(TESTIDS.sendTokenTile))
		expect(root.attributes("aria-selected")).toBe("true")
		expect(root.attributes("data-selected")).toBeDefined()
		expect(root.attributes("role")).toBe("option")
		w.unmount()
	})

	it("formats a balance in the token's own decimals", () => {
		const w = tile({ balance: 1_234_500_000n })
		// The symbol is already on the row, so the balance is the bare number.
		expect(w.find(sel(TESTIDS.sendTokenBalance)).text()).toBe("1,234.50")
		w.unmount()
	})

	it("honours an explicit decimals override", () => {
		const w = tile({ balance: 1_234_500_000n, decimals: 9 })
		expect(w.find(sel(TESTIDS.sendTokenTile)).text()).toContain("1.23")
		w.unmount()
	})

	it("a listed token shows its chain and its trimmed address, never the name a look-alike can copy", () => {
		const w = tile({ token: token({ source: "list" }), look: { sub: "Ethereum · Sepolia" } })
		const row = w.find(sel(TESTIDS.sendTokenAddress))
		expect(row.text()).toBe("0xA0b869…06eB48")
		expect(row.attributes("data-added")).toBeUndefined()
		expect(w.find(sel(TESTIDS.sendTokenSub)).text()).toBe("Ethereum · Sepolia · 0xA0b869…06eB48")
		expect(w.find(sel(TESTIDS.sendTokenTile)).text()).not.toContain("USD Coin")
		// EIP-55 casing in full on the row's title, so the trimmed form is never the only copy.
		expect(w.find(sel(TESTIDS.sendTokenTile)).attributes("title")).toBe("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48")
		w.unmount()
	})

	it("carries its chain's badge, and a row the look disables is shown muted and never picked", async () => {
		const w = tile({
			token: token({ chainId: 84532, logoKey: `84532:${USDC}` }),
			look: { sub: "Base Sepolia", withAddress: false, disabled: true },
		})
		const root = w.find(sel(TESTIDS.sendTokenTile))
		expect(w.find(sel(TESTIDS.sendTokenChain)).text()).toBe("BASE")
		expect(w.find(sel(TESTIDS.sendTokenSub)).text()).toBe("Base Sepolia")
		expect(w.find(sel(TESTIDS.sendTokenAddress)).exists()).toBe(false)
		expect(root.attributes("aria-disabled")).toBe("true")
		expect(w.find(sel(TESTIDS.sendTokenLogo)).attributes("style")).toBeUndefined()
		await root.trigger("click")
		expect(w.emitted("select")).toBeUndefined()
		w.unmount()
	})

	it("every row shows its trimmed address, manifest included, with the full checksum on hover", () => {
		const w = tile()
		expect(w.find(sel(TESTIDS.sendTokenAddress)).text()).toBe("0xA0b869…06eB48")
		expect(w.find(sel(TESTIDS.sendTokenTile)).attributes("title")).toBe("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48")
		w.unmount()
	})

	it("strips and caps a listed symbol before it reaches the DOM", () => {
		const bidi = `USD${String.fromCodePoint(0x202e)}C`
		const w = tile({ token: token({ source: "list", symbol: `${bidi}${"N".repeat(80)}` }) })
		const text = w.find(sel(TESTIDS.sendTokenSymbol)).text()
		expect(text).not.toContain(String.fromCodePoint(0x202e))
		expect(text).toMatch(/^USDCN+…$/)
		expect(text).not.toContain("N".repeat(33))
		w.unmount()
	})

	it("a row the user added shows its trimmed address and says so, and no name line", () => {
		const w = tile({ token: token({ source: "pasted", symbol: "PAXG", name: "Paxos Gold", logoKey: "11155111:0xfeed" }) })
		const address = w.find(sel(TESTIDS.sendTokenAddress))
		expect(address.attributes("data-added")).toBeDefined()
		expect(address.text()).toBe("0xA0b869…06eB48 · added by you")
		expect(w.text()).not.toContain("Paxos Gold")
		w.unmount()
	})

	it("names no provenance on any row — the address line is the only tell", () => {
		const w = tile({ token: token({ source: "list" }) })
		expect(w.text().toLowerCase()).not.toMatch(/\blist\b|manifest|pasted/)
		w.unmount()
	})

	it("shows no balance for a pasted token whose decimals are not read yet", () => {
		const w = tile({
			token: token({ source: "pasted", symbol: "", name: "", decimals: -1, logoKey: "11155111:0xfeed" }),
			balance: 5n,
		})
		expect(w.find(sel(TESTIDS.sendTokenTile)).text()).not.toContain("5")
		expect(w.find(sel(TESTIDS.sendTokenMonogram)).text()).toBe("??")
		w.unmount()
	})
})
