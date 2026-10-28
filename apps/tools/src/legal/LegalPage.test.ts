import { mount } from "@vue/test-utils"
import { describe, expect, it } from "vitest"
import type { LegalDocument } from "./document"
import LegalPage from "./LegalPage.vue"
import { LEGAL_TESTIDS } from "./testids"

const sel = (t: string) => `[data-testid="${t}"]`

const DOC: LegalDocument = {
	id: "unleashed-privacy-policy",
	title: "Privacy Policy",
	updated: "1 January",
	sections: [
		{
			heading: "Words",
			blocks: [
				{ kind: "p", text: '<script>alert("x")</script>' },
				{ kind: "list", items: ["one", "two"] },
			],
		},
		{
			heading: "Who sees what",
			blocks: [
				{
					kind: "providers",
					rows: [
						{
							name: "Host",
							origin: null,
							role: "Serves the pages.",
							sees: "Your IP address.",
							policyUrl: "https://host.example/privacy",
						},
					],
				},
			],
		},
	],
}

describe("LegalPage", () => {
	it("renders the title, the date and numbered sections", () => {
		const w = mount(LegalPage, { props: { doc: DOC } })
		expect(w.find("h1").text()).toBe("Privacy Policy")
		expect(w.text()).toContain("Last updated 1 January")
		expect(w.findAll("h2").map((h) => h.text())).toEqual(["1. Words", "2. Who sees what"])
		expect(w.findAll("li").map((li) => li.text())).toEqual(["one", "two"])
	})

	it("renders markup-shaped text as text, never as markup", () => {
		const w = mount(LegalPage, { props: { doc: DOC } })
		expect(w.find("script").exists()).toBe(false)
		expect(w.find("section p").text()).toBe('<script>alert("x")</script>')
	})

	it("lists each provider with its privacy policy, opened safely in a new tab", () => {
		const w = mount(LegalPage, { props: { doc: DOC } })
		const providers = w.find(sel(LEGAL_TESTIDS.providers))
		expect(providers.find("dt").text()).toBe("Host")
		const link = providers.find("a")
		expect(link.attributes("href")).toBe("https://host.example/privacy")
		expect(link.attributes("target")).toBe("_blank")
		expect(link.attributes("rel")).toBe("noopener noreferrer")
	})

	it("links back and to both documents, marking the one on screen", () => {
		const nav = mount(LegalPage, { props: { doc: DOC } }).find(sel(LEGAL_TESTIDS.nav))
		const links = nav.findAll("a")
		expect(links.map((a) => a.attributes("href"))).toEqual(["/", "/terms", "/privacy"])
		expect(links.map((a) => a.attributes("aria-current"))).toEqual([undefined, undefined, "page"])
	})
})
