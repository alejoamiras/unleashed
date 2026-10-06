import { mount } from "@vue/test-utils"
import { zeroAddress } from "viem"
import { describe, expect, it } from "vitest"
import type { LookupState } from "@/composables/useAddressLookup"
import { NETWORK } from "@/lib/network"
import type { Direction, SelectableToken } from "@/lib/send-model"
import { TESTIDS } from "@/lib/testids"
import TokenStep from "./TokenStep.vue"

const sel = (t: string) => `[data-testid="${t}"]`

const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"
const USDT = "0xdac17f958d2ee523a2206206994597c13d831ec7"
const LINK = "0x779877a7b0d9e8603169ddbd7836e478b4624789"

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

const TOKENS = [token(USDC, "USDC"), token(USDT, "USDT")]

const LOGO = `1:${LINK}`
const FOUND: LookupState = {
	status: "found",
	address: LINK,
	logoKey: LOGO,
	identity: { symbol: "LINK", name: "ChainLink Token", decimals: 18 },
}

type Props = {
	direction: Direction
	tokens: SelectableToken[]
	search: string
	loading: boolean
	catalogError: string | null
	lookup: LookupState | null
	addError: string | null
	selected: SelectableToken | null
	selectionError: string | null
	rowBalances?: Record<string, bigint>
	sources?: SelectableToken[]
	natives?: SelectableToken[]
	contractChains?: number[]
}

function step(over: Partial<Props> = {}) {
	return mount(TokenStep, {
		attachTo: document.body,
		props: {
			direction: "l1-to-l2",
			tokens: TOKENS,
			search: "",
			loading: false,
			catalogError: null,
			lookup: null,
			addError: null,
			selected: null,
			selectionError: null,
			...over,
		},
	})
}

describe("TokenStep", () => {
	it("shows the current query and reports every keystroke", async () => {
		const w = step({ search: "usd" })
		const field = w.find(sel(TESTIDS.sendTokenSearch))
		expect((field.element as HTMLInputElement).value).toBe("usd")
		await field.setValue("usdt")
		expect(w.emitted("update:search")).toEqual([["usdt"]])
		w.unmount()
	})

	it("passes a row selection up", async () => {
		const w = step()
		await w.findAll(sel(TESTIDS.sendTokenTile))[1]?.trigger("click")
		expect(w.emitted("select")?.[0]).toEqual([TOKENS[1]])
		w.unmount()
	})

	it("shows what an unlisted address resolves to, with the address itself, and Add passes it up", async () => {
		const w = step({ lookup: FOUND })
		const row = w.find(sel(TESTIDS.sendTokenLookup))
		expect(row.attributes("data-status")).toBe("found")
		expect(row.text()).toContain("LINK")
		expect(row.text()).toContain("ChainLink Token")
		expect(row.text()).toContain("18 decimals")
		expect(row.text()).toContain("0x779877…624789")
		await w.find(sel(TESTIDS.sendLookupAdd)).trigger("click")
		expect(w.emitted("add")).toEqual([[LINK]])
		w.unmount()
	})

	it("hides the list while a lookup is showing, and says it is reading", () => {
		const w = step({ lookup: { status: "reading", address: LINK, logoKey: LOGO } })
		expect(w.find(sel(TESTIDS.sendTokenList)).exists()).toBe(false)
		expect(w.find(sel(TESTIDS.sendTokenLookup)).text()).toContain("Reading")
		expect(w.find(sel(TESTIDS.sendLookupAdd)).exists()).toBe(false)
		w.unmount()
	})

	it("shows the contract's complaint when the address is not a token, with nothing to add", () => {
		const w = step({ lookup: { status: "error", address: LINK, logoKey: LOGO, message: "Token has no usable decimals()." } })
		expect(w.find(sel(TESTIDS.sendTokenLookup)).text()).toContain("no usable decimals")
		expect(w.find(sel(TESTIDS.sendLookupAdd)).exists()).toBe(false)
		w.unmount()
	})

	it("strips a looked-up symbol before it renders", () => {
		const bidi = `LI${String.fromCodePoint(0x202e)}NK`
		const w = step({ lookup: { ...FOUND, identity: { ...FOUND.identity, symbol: bidi } } })
		const text = w.find(sel(TESTIDS.sendTokenLookup)).text()
		expect(text).not.toContain(String.fromCodePoint(0x202e))
		expect(text).toContain("LINK")
		w.unmount()
	})

	it("surfaces what the catalog said when the address was added", () => {
		const w = step({ addError: "That token is already in the list." })
		expect(w.find(sel(TESTIDS.sendLookupError)).text()).toContain("already in the list")
		w.unmount()
	})

	it("surfaces a catalog failure without hiding the tokens it does have", () => {
		const w = step({ catalogError: "The token list could not be loaded." })
		expect(w.find(sel(TESTIDS.sendCatalogError)).text()).toContain("could not be loaded")
		expect(w.findAll(sel(TESTIDS.sendTokenTile))).toHaveLength(2)
		w.unmount()
	})

	it("strips and caps every error it shows", () => {
		const hostile = `${String.fromCodePoint(0x202e)}${"x".repeat(10_000)}`
		const lookup = { status: "error", address: LINK, logoKey: LOGO, message: hostile } as const
		const w = step({ catalogError: hostile, selectionError: hostile, addError: hostile, lookup })
		for (const id of [TESTIDS.sendCatalogError, TESTIDS.sendSelectionError, TESTIDS.sendLookupError, TESTIDS.sendTokenLookup]) {
			const text = w.find(sel(id)).text()
			expect(text).not.toContain(String.fromCodePoint(0x202e))
			expect(Array.from(text).length).toBeLessThanOrEqual(241)
		}
		w.unmount()
	})

	it("hands the rows their Ethereum balances", () => {
		const w = step({ rowBalances: { [`1:${USDT}`]: 2_500_000n } })
		expect(w.findAll(sel(TESTIDS.sendTokenTile))[1]?.text()).toContain("2.50")
		w.unmount()
	})

	it("has no footer, no summary and no Continue — picking a row is the step", () => {
		const w = step({ selected: TOKENS[0] })
		expect(w.findAll("button").filter((b) => b.text() === "Continue")).toHaveLength(0)
		expect(w.text()).not.toMatch(/reading|sending|balance on/i)
		w.unmount()
	})

	it("announces a selection failure politely", () => {
		const w = step({ selected: TOKENS[0], selectionError: "That address is not an ERC-20." })
		const err = w.find(sel(TESTIDS.sendSelectionError))
		expect(err.attributes("aria-live")).toBe("polite")
		expect(err.text()).toContain("not an ERC-20")
		w.unmount()
	})

	it("keeps mechanism and first-time vocabulary out of the step", () => {
		const w = step({ selected: TOKENS[0] })
		expect(w.text().toLowerCase()).not.toMatch(/portal|register|first time/)
		w.unmount()
	})
})

describe("TokenStep — the chains a deposit can start on", () => {
	const L1 = NETWORK.l1ChainId
	const BASE = 84532
	const ARB = 42161
	const ETH_USDC = token(USDC, "USDC", { chainId: L1, logoKey: `${L1}:${USDC}` })
	const LISTED = token(USDT, "USDT", { chainId: L1, source: "list", logoKey: `${L1}:${USDT}` })
	const SOURCES = [
		token(LINK, "USDC", { chainId: BASE, logoKey: `${BASE}:${LINK}` }),
		token(USDT, "WETH", { chainId: ARB, decimals: 18, logoKey: `${ARB}:${USDT}` }),
	]
	const NATIVES = [L1, BASE, ARB].map((id) =>
		token(zeroAddress, "ETH", { chainId: id, decimals: 18, source: "list", logoKey: `native:${id}` }),
	)
	const keys = (w: ReturnType<typeof step>) => w.findAll(sel(TESTIDS.sendTokenTile)).map((t) => t.attributes("data-key"))
	const tile = (w: ReturnType<typeof step>, key: string) => w.get(`${sel(TESTIDS.sendTokenTile)}[data-key="${key}"]`)
	const crossChain = (over: Partial<Props> = {}) => step({ tokens: [ETH_USDC, LISTED], sources: SOURCES, natives: NATIVES, ...over })

	it("lists the sources first, then Ethereum's catalog, then each chain's native coin, which only pays fees", async () => {
		const w = crossChain({ rowBalances: { "native:84532": 8_000_000_000_000_000n, [`native:${L1}`]: 400_000_000_000_000_000n } })
		expect(w.text()).toContain("Send from")
		expect(w.get(sel(TESTIDS.sendTokenSearch)).attributes("placeholder")).toBe("Search tokens on every network")
		expect(keys(w)).toEqual([...SOURCES, ETH_USDC, LISTED, ...NATIVES].map((t) => t.logoKey))
		const sub = (key: string) => tile(w, key).get(sel(TESTIDS.sendTokenSub)).text()
		expect(sub(`${BASE}:${LINK}`)).toBe("Base Sepolia")
		expect(sub(ETH_USDC.logoKey)).toBe("Ethereum · Sepolia · no bridge step")
		expect(sub(LISTED.logoKey)).toBe("Ethereum · Sepolia · 0xdAC17F…831ec7")
		expect(sub("native:84532")).toBe("pays your Base Sepolia fees")
		const native = tile(w, "native:84532")
		expect(native.attributes("aria-disabled")).toBe("true")
		expect(native.get(sel(TESTIDS.sendTokenBalance)).text()).toBe("0.0080")
		expect(tile(w, `native:${L1}`).get(sel(TESTIDS.sendTokenBalance)).text()).toBe("0.40")
		expect(tile(w, `native:${ARB}`).get(sel(TESTIDS.sendTokenBalance)).text()).toBe("—")
		await native.trigger("click")
		await tile(w, `${BASE}:${LINK}`).trigger("click")
		expect(w.emitted("select")).toEqual([[SOURCES[0]]])
		w.unmount()
	})

	it("a network chip narrows the list to its chain, and under a source chain names what it routes", async () => {
		const w = crossChain()
		const chips = w.get(sel(TESTIDS.sendNetworkChips))
		const chip = (id: number) => w.get(`${sel(TESTIDS.sendNetworkChip)}[data-chain="${id}"]`)
		expect(chips.attributes("aria-label")).toBe("Network")
		expect(chips.findAll("button").map((b) => b.text())).toEqual(["All", "Base Sepolia", "Arbitrum", "Ethereum · Sepolia"])
		await chip(BASE).trigger("click")
		expect(chip(BASE).attributes("aria-pressed")).toBe("true")
		expect(keys(w)).toEqual([`${BASE}:${LINK}`, "native:84532"])
		expect(w.get(sel(TESTIDS.sendSourceOnly)).text()).toBe("Only USDC can be sent for now.")
		await chip(L1).trigger("click")
		expect(keys(w)).toEqual([ETH_USDC.logoKey, LISTED.logoKey, `native:${L1}`])
		expect(w.find(sel(TESTIDS.sendSourceOnly)).exists()).toBe(false)
		w.unmount()
	})

	it("refuses a smart-contract wallet on the chains where it has code, and offers to change wallet", async () => {
		const w = crossChain({ contractChains: [BASE, ARB] })
		const alert = w.get(sel(TESTIDS.sendContractWallet))
		expect(alert.attributes("role")).toBe("alert")
		expect(alert.text()).toContain("This wallet is a smart contract, so it can’t send from Base Sepolia or Arbitrum.")
		expect(alert.text()).toContain("Connect a regular wallet account to send from those networks.")
		expect(keys(w).slice(0, 2)).toEqual([ETH_USDC.logoKey, LISTED.logoKey])
		const refused = tile(w, `${BASE}:${LINK}`)
		expect(refused.attributes("aria-disabled")).toBe("true")
		await refused.trigger("click")
		expect(w.emitted("select")).toBeUndefined()
		await w.get(sel(TESTIDS.sendChangeWallet)).trigger("click")
		expect(w.emitted("change-wallet")).toHaveLength(1)
		w.unmount()
	})

	it("an Ethereum-only build shows no chips, no native rows and the search it always had", () => {
		const w = step({ tokens: [ETH_USDC], natives: NATIVES })
		expect(w.find(sel(TESTIDS.sendNetworkChips)).exists()).toBe(false)
		expect(w.text()).not.toContain("Send from")
		expect(keys(w)).toEqual([ETH_USDC.logoKey])
		expect(w.get(sel(TESTIDS.sendTokenSearch)).attributes("placeholder")).toBe("Search a token, or paste its Ethereum address")
		w.unmount()
	})
})
