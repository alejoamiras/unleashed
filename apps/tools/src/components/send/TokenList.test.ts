import { mount } from "@vue/test-utils"
import { describe, expect, it } from "vitest"
import type { SelectableToken } from "@/lib/send-model"
import { TESTIDS } from "@/lib/testids"
import TokenList from "./TokenList.vue"

const sel = (t: string) => `[data-testid="${t}"]`

const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"
const USDT = "0xdac17f958d2ee523a2206206994597c13d831ec7"
const PXO = "0x1111111111111111111111111111111111111111"

function token(address: string, symbol: string, over: Partial<SelectableToken> = {}): SelectableToken {
	return {
		chainId: 1,
		address,
		symbol,
		name: `${symbol} token`,
		decimals: 6,
		source: "manifest",
		logoKey: `1:${address}`,
		...over,
	} as SelectableToken
}

const TOKENS = [token(USDC, "USDC"), token(USDT, "USDT"), token(PXO, "PXO", { source: "list" })]

type Props = {
	tokens: SelectableToken[]
	selected: SelectableToken | null
	balances: Record<string, bigint>
	loading: boolean
	empty: boolean
}

function list(over: Partial<Props> = {}) {
	return mount(TokenList, {
		attachTo: document.body,
		props: { tokens: TOKENS, selected: null, loading: false, empty: false, ...over },
	})
}

describe("TokenList", () => {
	it("renders one row per token, in the order given", () => {
		const w = list()
		expect(w.find(sel(TESTIDS.sendTokenList)).attributes("role")).toBe("listbox")
		expect(w.findAll(sel(TESTIDS.sendTokenTile)).map((t) => t.attributes("data-key"))).toEqual([`1:${USDC}`, `1:${USDT}`, `1:${PXO}`])
		w.unmount()
	})

	it("emits select with the clicked token", async () => {
		const w = list()
		await w.findAll(sel(TESTIDS.sendTokenTile))[1]?.trigger("click")
		expect(w.emitted("select")?.[0]).toEqual([TOKENS[1]])
		w.unmount()
	})

	it("is ONE tab stop: the selected row carries it", () => {
		const w = list({ selected: TOKENS[2] })
		expect(w.findAll(sel(TESTIDS.sendTokenTile)).map((t) => t.attributes("tabindex"))).toEqual(["-1", "-1", "0"])
		w.unmount()
	})

	it("puts the tab stop on the first row while nothing is selected", () => {
		const w = list()
		expect(w.findAll(sel(TESTIDS.sendTokenTile)).map((t) => t.attributes("tabindex"))).toEqual(["0", "-1", "-1"])
		w.unmount()
	})

	it("keeps the tab stop on the first row when the selection is not in the list", () => {
		const w = list({ selected: token("0xdead", "GONE") })
		expect(w.findAll(sel(TESTIDS.sendTokenTile)).map((t) => t.attributes("tabindex"))).toEqual(["0", "-1", "-1"])
		w.unmount()
	})

	it("↓ moves focus to the next row without picking it — picking is the step, browsing is not", async () => {
		const w = list()
		const rows = w.findAll(sel(TESTIDS.sendTokenTile))
		await rows[0]?.trigger("keydown", { key: "ArrowDown" })
		expect(document.activeElement).toBe(rows[1]?.element)
		expect(w.emitted("select")).toBeUndefined()
		// The tab stop follows focus, so leaving and re-entering the list lands where the user was.
		expect(w.findAll(sel(TESTIDS.sendTokenTile)).map((t) => t.attributes("tabindex"))).toEqual(["-1", "0", "-1"])
		w.unmount()
	})

	it("↑ from the first row wraps to the last; Enter on the focused row picks it", async () => {
		const w = list()
		const rows = w.findAll(sel(TESTIDS.sendTokenTile))
		await rows[0]?.trigger("keydown", { key: "ArrowUp" })
		expect(document.activeElement).toBe(rows[2]?.element)
		expect(w.emitted("select")).toBeUndefined()
		// A native button: Enter and Space click it.
		await rows[2]?.trigger("click")
		expect(w.emitted("select")?.[0]).toEqual([TOKENS[2]])
		w.unmount()
	})

	it("says so while loading, and nothing about where the list came from otherwise", () => {
		const w = list({ loading: true })
		expect(w.find(sel(TESTIDS.sendCatalogLoading)).text()).toContain("Loading")
		const settled = list()
		expect(settled.find(sel(TESTIDS.sendCatalogLoading)).exists()).toBe(false)
		expect(settled.text().toLowerCase()).not.toMatch(/manifest|list|pasted|cache/)
		w.unmount()
		settled.unmount()
	})

	it("offers the address route when the filter matches nothing", () => {
		const w = list({ tokens: [], empty: true })
		expect(w.find(sel(TESTIDS.sendCatalogEmpty)).text()).toContain("Paste")
		w.unmount()
	})

	it("never shows the empty line while the list is still loading", () => {
		const w = list({ tokens: [], empty: true, loading: true })
		expect(w.find(sel(TESTIDS.sendCatalogEmpty)).exists()).toBe(false)
		w.unmount()
	})

	it("passes balances to the rows by logoKey", () => {
		const w = list({ balances: { [`1:${USDT}`]: 2_500_000n } })
		const rows = w.findAll(sel(TESTIDS.sendTokenTile))
		expect(rows[1]?.text()).toContain("2.50")
		expect(rows[0]?.text()).not.toContain("2.50")
		w.unmount()
	})
})
