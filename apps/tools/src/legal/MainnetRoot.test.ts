import { mount } from "@vue/test-utils"
import { afterEach, describe, expect, it } from "vitest"
import { TESTIDS } from "@/lib/testids"
import MainnetRoot from "./MainnetRoot.vue"
import { LEGAL_TESTIDS } from "./testids"

const sel = (t: string) => `[data-testid="${t}"]`

function at(path: string) {
	window.history.replaceState(null, "", path)
	return mount(MainnetRoot)
}

afterEach(() => {
	window.history.replaceState(null, "", "/")
})

describe("MainnetRoot", () => {
	it("shows the Terms of Use at /terms", () => {
		const w = at("/terms")
		expect(w.find(sel(LEGAL_TESTIDS.page)).attributes("data-legal-doc")).toBe("unleashed-terms-of-use")
		expect(w.find(sel(TESTIDS.mainnetPlaceholder)).exists()).toBe(false)
	})

	it("shows the Privacy Policy at /privacy, ignoring case and one trailing slash", () => {
		const w = at("/Privacy/")
		expect(w.find(sel(LEGAL_TESTIDS.page)).attributes("data-legal-doc")).toBe("unleashed-privacy-policy")
	})

	it("shows the placeholder, with its three links, at /", () => {
		const w = at("/")
		expect(w.find(sel(TESTIDS.mainnetPlaceholder)).exists()).toBe(true)
		expect(w.findAll(sel(TESTIDS.mainnetPlaceholderLink))).toHaveLength(3)
		expect(w.find(sel(TESTIDS.tabs)).exists()).toBe(false)
	})

	it("shows the placeholder at any other path", () => {
		for (const path of ["/bridge", "/terms/extra"]) {
			const w = at(path)
			expect(w.find(sel(TESTIDS.mainnetPlaceholder)).exists()).toBe(true)
			expect(w.find(sel(LEGAL_TESTIDS.page)).exists()).toBe(false)
		}
	})
})
