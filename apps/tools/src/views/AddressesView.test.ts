import { flushPromises, mount } from "@vue/test-utils"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { TESTIDS } from "@/lib/testids"

const gen = vi.hoisted(() => ({ promoted: true }))

vi.mock("@/lib/network", () => ({ NETWORK: { viemChain: { name: "Sepolia" } } }))
vi.mock("@/contracts/bridge-generation", () => ({
	get GENERATION() {
		return gen.promoted ? { l1: { factory: "0xfactory", router: "0xrouter", depositRouter: "0xdepositrouter" } } : null
	},
	get HUB() {
		return gen.promoted ? { toString: () => "0xhub" } : undefined
	},
	FUEL_PORTAL: "0xfeejuice",
}))
vi.mock("@/contracts/deployments", () => ({
	DRIPPER: { toString: () => "0xdripper" },
	SIGNAL: { toString: () => "0xsignal" },
	NOISE: { toString: () => "0xnoise" },
}))
vi.mock("@/lib/explorer", () => ({
	etherscanAddressUrl: (a: string) => `https://l1.example/address/${a}`,
	explorerAddressUrl: (a: string) => `https://l2.example/${a}`,
}))

const sel = (t: string) => `[data-testid="${t}"]`

async function view() {
	vi.resetModules()
	const { default: AddressesView } = await import("./AddressesView.vue")
	return mount(AddressesView)
}

describe("AddressesView", () => {
	// The first import transforms the view's whole graph; outside a test's timeout a loaded machine cannot fail it.
	beforeAll(() => import("./AddressesView.vue"), 60_000)
	beforeEach(() => {
		gen.promoted = true
	})
	afterEach(() => vi.unstubAllGlobals())

	it("lists every contract by chain, each with its full address and an explorer link in a new tab", async () => {
		const w = await view()
		expect(w.findAll("h2").map((h) => h.text())).toEqual(["Ethereum · Sepolia", "Aztec"])
		const rows = w.findAll(sel(TESTIDS.addressRow))
		expect(rows.map((r) => [r.attributes("data-contract"), r.get("code").text()])).toEqual([
			["Portal factory", "0xfactory"],
			// The router sends go through, never the retired one.
			["Router", "0xdepositrouter"],
			["Fee Juice portal", "0xfeejuice"],
			["Bridge hub", "0xhub"],
			["SIGNAL", "0xsignal"],
			["NOISE", "0xnoise"],
			["Dripper", "0xdripper"],
		])
		const links = w.findAll("a")
		expect(links[0]?.attributes("href")).toBe("https://l1.example/address/0xfactory")
		expect(links[3]?.attributes("href")).toBe("https://l2.example/0xhub")
		expect(links.every((a) => a.attributes("target") === "_blank" && a.attributes("rel") === "noopener noreferrer")).toBe(true)
	})

	it("drops the bridge's rows, and the empty Ethereum group, until a generation is promoted", async () => {
		gen.promoted = false
		const w = await view()
		expect(w.findAll("h2").map((h) => h.text())).toEqual(["Aztec"])
		expect(w.findAll(sel(TESTIDS.addressRow)).map((r) => r.attributes("data-contract"))).toEqual(["SIGNAL", "NOISE", "Dripper"])
	})

	it("copies the full address", async () => {
		const writeText = vi.fn(async () => {})
		vi.stubGlobal("navigator", { clipboard: { writeText } })
		const w = await view()
		await w.get(sel(TESTIDS.addressRow)).get("button").trigger("click")
		await flushPromises()
		expect(writeText).toHaveBeenCalledWith("0xfactory")
	})
})
