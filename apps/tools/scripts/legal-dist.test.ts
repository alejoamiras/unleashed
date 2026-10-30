import { describe, expect, it } from "vitest"
import { legalDistProblems } from "./legal-dist"

const TERMS = "https://unleashed.systems/terms"
const PRIVACY = "https://unleashed.systems/privacy"
const DOCS = `id:"unleashed-terms-of-use" … id:"unleashed-privacy-policy" … "tl-terms-gate"`

const mainnetDist = () =>
	new Map([
		["index.html", "<html></html>"],
		["assets/index-a1.js", "app code"],
		["assets/MainnetRoot-b2.js", `${DOCS} href:"${TERMS}" … href:"${PRIVACY}"`],
	])
const otherDist = () =>
	new Map([
		["index.html", "<html></html>"],
		["assets/index-a1.js", "app code"],
		["assets/AppShell-c3.js", "shell code"],
	])

describe("legalDistProblems", () => {
	it("accepts a mainnet dist linking and carrying both documents", () => {
		expect(legalDistProblems("mainnet", mainnetDist())).toEqual([])
	})

	it("accepts testnet and local dists carrying neither", () => {
		expect(legalDistProblems("testnet", otherDist())).toEqual([])
		expect(legalDistProblems("local", otherDist())).toEqual([])
	})

	it.each([
		[TERMS, PRIVACY],
		[PRIVACY, TERMS],
	])("refuses a mainnet dist that does not link %s", (missing, kept) => {
		const dist = mainnetDist()
		dist.set("assets/MainnetRoot-b2.js", `${DOCS} href:"${kept}"`)
		expect(legalDistProblems("mainnet", dist)).toEqual([`mainnet dist does not link ${missing}`])
	})

	it("refuses a mainnet dist without a document's data, as when the gate is missing", () => {
		const dist = mainnetDist()
		dist.set("assets/MainnetRoot-b2.js", `id:"unleashed-terms-of-use" href:"${TERMS}" href:"${PRIVACY}"`)
		expect(legalDistProblems("mainnet", dist)).toEqual([
			`mainnet dist does not carry the document "unleashed-privacy-policy"`,
			`mainnet dist does not carry the acceptance gate "tl-terms-gate"`,
		])
	})

	it("refuses a testnet dist carrying a gate string in a shared chunk, naming the file", () => {
		const dist = otherDist()
		dist.set("assets/index-a1.js", `app code "tl-terms-gate-sign"`)
		expect(legalDistProblems("testnet", dist)).toEqual([`testnet dist carries "tl-terms-gate" in assets/index-a1.js`])
	})

	it("refuses a testnet dist carrying a document URL, naming the file", () => {
		const dist = otherDist()
		dist.set("assets/index-a1.js", `app code ${PRIVACY}`)
		expect(legalDistProblems("testnet", dist)).toEqual([`testnet dist carries "${PRIVACY}" in assets/index-a1.js`])
	})

	it("refuses a local dist carrying a document id", () => {
		const dist = otherDist()
		dist.set("assets/AppShell-c3.js", "shell unleashed-terms-of-use")
		expect(legalDistProblems("local", dist)).toEqual([`local dist carries "unleashed-terms-of-use" in assets/AppShell-c3.js`])
	})

	it.each(["assets/MainnetPlaceholderView-b2.css", "assets/MainnetRoot-d4.js"])(
		"refuses a testnet dist shipping a mainnet root chunk (%s)",
		(chunk) => {
			const dist = otherDist()
			dist.set(chunk, "")
			expect(legalDistProblems("testnet", dist)).toEqual([`testnet dist ships the mainnet root: ${chunk}`])
		},
	)
})
