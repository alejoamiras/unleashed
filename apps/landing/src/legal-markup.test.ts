import type { LegalDocument } from "@unleashed/legal"
import { describe, expect, test } from "vitest"
import { CANONICAL } from "./content.ts"
import { block, legalBody, legalHead } from "./legal-markup.ts"
import { LEGAL_PAGES } from "./legal-pages.ts"

describe("legal pages", () => {
	test("one page per document, at its URL's path on the canonical origin", () => {
		expect(LEGAL_PAGES.map((page) => [page.path, page.file])).toEqual([
			["/terms", "terms.html"],
			["/privacy", "privacy.html"],
		])
		for (const page of LEGAL_PAGES) expect(new URL(page.url).origin).toBe(new URL(CANONICAL).origin)
	})

	test("renders every block kind with each string as text", () => {
		expect(block({ kind: "p", text: "<script>x</script>" })).toBe("<p>&lt;script&gt;x&lt;/script&gt;</p>")
		expect(block({ kind: "list", items: ["a & b", "c"] })).toBe("<ul><li>a &amp; b</li><li>c</li></ul>")
		const row = { name: "Host", origin: null, role: "Hosts.", sees: "IPs.", policyUrl: "https://host.example/privacy" }
		expect(block({ kind: "providers", rows: [row] })).toBe(
			'<dl class="providers"><div><dt>Host</dt><dd>Hosts.</dd><dd>IPs.</dd><dd><a href="https://host.example/privacy">Host&#39;s privacy policy</a></dd></div></dl>',
		)
	})

	test("numbers the sections, marks the current page in the nav and names its canonical URL", () => {
		const [terms, privacy] = LEGAL_PAGES
		const doc: LegalDocument = {
			...terms.doc,
			sections: [
				{ heading: "First", blocks: [] },
				{ heading: "Second", blocks: [] },
			],
		}
		const html = legalBody({ ...terms, doc })
		expect(html).toContain("<h2>1. First</h2>")
		expect(html).toContain("<h2>2. Second</h2>")
		expect(html).toContain(`<a class="doc ul-notch" href="/terms" aria-current="page">${terms.doc.title}</a>`)
		expect(html).toContain(`<a class="doc ul-notch" href="/privacy">${privacy.doc.title}</a>`)
		expect(html).not.toContain("data-motion")
		expect(legalHead(privacy)).toContain(`<link rel="canonical" href="${privacy.url}" />`)
	})
})
