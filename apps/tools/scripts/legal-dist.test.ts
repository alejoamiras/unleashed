import { describe, expect, it } from "vitest"
import { legalDistProblems } from "./legal-dist"

const TERMS = "https://unleashed.systems/terms"
const PRIVACY = "https://unleashed.systems/privacy"

const mainnetDist = () =>
	new Map([
		["index.html", "<html></html>"],
		["assets/index-a1.js", "app code"],
		["assets/MainnetPlaceholderView-b2.js", `href:"${TERMS}" … href:"${PRIVACY}"`],
	])
const otherDist = () =>
	new Map([
		["index.html", "<html></html>"],
		["assets/index-a1.js", "app code"],
		["assets/AppShell-c3.js", "shell code"],
	])

describe("legalDistProblems", () => {
	it("accepts a mainnet dist linking both documents", () => {
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
		dist.set("assets/MainnetPlaceholderView-b2.js", `href:"${kept}"`)
		expect(legalDistProblems("mainnet", dist)).toEqual([`mainnet dist does not link ${missing}`])
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

	it("refuses a testnet dist shipping the placeholder's chunk", () => {
		const dist = otherDist()
		dist.set("assets/MainnetPlaceholderView-b2.css", "")
		expect(legalDistProblems("testnet", dist)).toEqual([
			"testnet dist ships the mainnet placeholder: assets/MainnetPlaceholderView-b2.css",
		])
	})
})
