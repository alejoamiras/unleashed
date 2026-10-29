import { mount } from "@vue/test-utils"
import { LEGAL_URLS, PRIVACY, TERMS } from "@unleashed/legal"
import { describe, expect, it } from "vitest"
import { TESTIDS } from "@/lib/testids"
import MainnetPlaceholderView from "./MainnetPlaceholderView.vue"

const sel = (t: string) => `[data-testid="${t}"]`

describe("MainnetPlaceholderView", () => {
	it("renders the placeholder root", () => {
		const w = mount(MainnetPlaceholderView)
		expect(w.find(sel(TESTIDS.mainnetPlaceholder)).exists()).toBe(true)
	})

	it("states the upgrade + what comes back", () => {
		const w = mount(MainnetPlaceholderView)
		expect(w.text()).toContain("Bridging is being upgraded")
		expect(w.text()).toContain("next mainnet generation")
	})

	it("offers exactly three links", () => {
		const links = mount(MainnetPlaceholderView).findAll(sel(TESTIDS.mainnetPlaceholderLink))
		expect(links).toHaveLength(3)
		expect(links.map((l) => l.text())).toEqual(["Wallet site", "Get the extension", "Docs"])
		expect(links.map((l) => l.attributes("href"))).toEqual(["https://nulo.sh", "https://nulo.sh", "https://github.com/nulo-sh/nulo"])
	})

	it("links both legal documents on the public landing, by their titles", () => {
		const links = mount(MainnetPlaceholderView).findAll(sel(TESTIDS.mainnetPlaceholderLegalLink))
		expect(links.map((l) => l.text())).toEqual([TERMS.title, PRIVACY.title])
		expect(links.map((l) => l.attributes("href"))).toEqual([LEGAL_URLS[TERMS.id], LEGAL_URLS[PRIVACY.id]])
	})

	it("opens every link safely in a new tab", () => {
		const w = mount(MainnetPlaceholderView)
		for (const link of [...w.findAll(sel(TESTIDS.mainnetPlaceholderLink)), ...w.findAll(sel(TESTIDS.mainnetPlaceholderLegalLink))]) {
			expect(link.attributes("target")).toBe("_blank")
			expect(link.attributes("rel")).toBe("noopener noreferrer")
		}
	})

	it("carries no wallet, tab or bridge affordance", () => {
		const w = mount(MainnetPlaceholderView)
		expect(w.find(sel(TESTIDS.tabs)).exists()).toBe(false)
		expect(w.find(sel(TESTIDS.btnConnect)).exists()).toBe(false)
		expect(w.findAll("button")).toHaveLength(0)
	})
})
