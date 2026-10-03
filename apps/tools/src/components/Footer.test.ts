import { mount } from "@vue/test-utils"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("@/contracts/deployments", () => ({
	DRIPPER: { toString: () => "0xdripper" },
	SIGNAL: { toString: () => "0xusdc" },
	NOISE: { toString: () => "0xeth" },
}))

// VITE_EXPLORER_BASE_URL may be set via .env.local on a dev's machine, so the explorer helper is
// mocked: "" (no explorer) unless a case sets a base.
const addressUrl = vi.hoisted(() => ({ base: "" }))
vi.mock("@/lib/explorer", () => ({
	explorerTxUrl: () => "",
	explorerAddressUrl: (a: string) => (addressUrl.base ? `${addressUrl.base}/${a}` : ""),
}))

import Footer from "./Footer.vue"

describe("Footer", () => {
	afterEach(() => {
		addressUrl.base = ""
	})

	it("links each contract to the explorer in a new tab, separated by middots", () => {
		addressUrl.base = "https://explorer.test/address"
		const contracts = mount(Footer).get(".contracts")
		const anchors = contracts.findAll("a")
		expect(anchors.map((a) => a.attributes("href"))).toEqual([
			"https://explorer.test/address/0xusdc",
			"https://explorer.test/address/0xeth",
			"https://explorer.test/address/0xdripper",
		])
		for (const a of anchors) {
			expect(a.attributes("target")).toBe("_blank")
			expect(a.attributes("rel")).toBe("noopener noreferrer")
		}
		expect(contracts.text()).toBe("Contracts: SIGNAL · NOISE · Dripper")
	})

	it("renders the contract labels (SIGNAL, NOISE, Dripper)", () => {
		const w = mount(Footer)
		expect(w.text()).toContain("SIGNAL")
		expect(w.text()).toContain("NOISE")
		expect(w.text()).toContain("Dripper")
	})

	it("renders no tagline on either network (the page header already says it)", () => {
		const text = mount(Footer).text()
		expect(text).not.toMatch(/Alpha-testnet only|Play tokens|Permissionless dripper|No rate limit|No real value/)
	})

	it("renders external link to Wonderland aztec-standards", () => {
		const w = mount(Footer)
		const a = w.findAll("a").find((el) => el.text().includes("Wonderland"))
		expect(a?.attributes("href")).toBe("https://github.com/defi-wonderland/aztec-standards")
		expect(a?.attributes("target")).toBe("_blank")
		expect(a?.attributes("rel")).toContain("noopener")
	})

	it("credits no product of its own beside the external links", () => {
		expect(mount(Footer).text()).not.toMatch(/powered by/i)
	})

	it("does NOT render contract anchor tags when VITE_EXPLORER_BASE_URL is unset", () => {
		// In tests jsdom has no VITE_EXPLORER_BASE_URL → explorerAddressUrl
		// returns "". Footer falls back to plain text labels.
		const w = mount(Footer)
		const contractsLine = w.find(".contracts")
		// Should have NO anchor tag for SIGNAL/ETH/Dripper labels (only
		// the external "Wonderland" / "Aztec" links).
		const anchors = contractsLine.findAll("a")
		expect(anchors.length).toBe(0)
	})
})
