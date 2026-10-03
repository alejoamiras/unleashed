import { describe, expect, test } from "vitest"
import { extractPaths } from "./vendor-icons"

const svg = (inner: string, root = `xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="currentColor" viewBox="0 0 24 24"`) =>
	`<svg ${root}>\n${inner}\n</svg>\n`

describe("extractPaths", () => {
	test("keeps every path's data in source order", () => {
		expect(extractPaths(svg(`<path d="M1 1h2v2z"/>\n  <path d="M3 3h1v1z"/>`))).toEqual({
			viewBox: "0 0 24 24",
			d: ["M1 1h2v2z", "M3 3h1v1z"],
		})
	})

	test.each([
		["another element", svg(`<path d="M1 1h2z"/><g><path d="M2 2z"/></g>`)],
		["a script", svg(`<path d="M1 1h2z"/><script>alert(1)</script>`)],
		["a path attribute other than d", svg(`<path d="M1 1h2z" onclick="x()"/>`)],
		["a root attribute outside the allowlist", svg(`<path d="M1 1h2z"/>`, `viewBox="0 0 24 24" onload="x()"`)],
		["path data outside the grammar", svg(`<path d="M1 1 url(#x)"/>`)],
		["a single-quoted root attribute", svg(`<path d="M1 1h2z"/>`, `viewBox="0 0 24 24" onload='x()'`)],
		["a single-quoted path attribute", svg(`<path d="M1 1h2z" transform='translate(1 1)'/>`)],
		["a repeated attribute", svg(`<path d="M1 1h2z" d="M2 2h1z"/>`)],
		["no paths", svg("")],
	])("refuses %s", (_, input) => {
		expect(() => extractPaths(input)).toThrow()
	})
})
