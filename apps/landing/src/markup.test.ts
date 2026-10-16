import { readFileSync } from "node:fs"
import { MARK_INK } from "@unleashed/design/core/mark.ts"
import { describe, expect, test } from "vitest"
import { EXPERIMENTS, type Experiment, LINKS } from "./content.ts"
import { esc, experimentRow, renderBody, tag } from "./markup.ts"

const body = renderBody()
const allowed = new Set<string>(Object.values(LINKS))

describe("page markup", () => {
	test("escapes every character that could leave a text node or an attribute", () => {
		expect(esc(`<a href="x" onclick='y'>&</a>`)).toBe("&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;")
	})

	test("links only to LINKS", () => {
		const hrefs = [...body.matchAll(/href="([^"]*)"/g)].map((m) => m[1])
		expect(hrefs.length).toBeGreaterThan(0)
		for (const href of hrefs) expect(allowed.has(href), href).toBe(true)
	})

	test("renders one row per experiment, the open slot as a div, and a screen only where an engine is named", () => {
		const open: Experiment = { name: "Next", href: null, tags: ["lab"], description: "Soon.", engine: null }
		expect(experimentRow(open)).toMatch(/^<li><div class="empty ul-notch"><strong>Next<\/strong>/)
		expect(experimentRow(open)).not.toContain("<canvas")
		const rows = [...body.matchAll(/<li>/g)].length
		expect(rows).toBe(EXPERIMENTS.length)
		for (const e of EXPERIMENTS.filter((x) => x.engine)) expect(body).toContain(`<canvas data-engine="${e.engine}">`)
	})

	test("maps each tag kind to its style and icon", () => {
		expect(tag("live")).toMatch(/^<span class="tag carrier ul-notch"><svg class="ic"[^>]*>.*<\/svg>Live on testnet<\/span>$/)
		expect(tag("private")).toContain('class="tag private ul-notch"')
		expect(tag("lab")).toContain('class="tag other ul-notch"')
	})

	test("ships the Pause button hidden, for main.ts to reveal", () => {
		expect(body).toMatch(/<button type="button" class="btn quiet sm ul-notch" data-motion hidden>Pause motion<\/button>/)
	})
})

describe("shared brand assets", () => {
	test("the mark matches the app shell's until AppShell imports core/mark.ts", () => {
		const shell = readFileSync(new URL("../../tools/src/AppShell.vue", import.meta.url), "utf8")
		expect(shell).toContain(`"${MARK_INK}"`)
	})

	test("the favicon is the app's, byte for byte", () => {
		const read = (app: string) => readFileSync(new URL(`../../${app}/public/favicon.svg`, import.meta.url))
		expect(read("landing").equals(read("tools"))).toBe(true)
	})
})
