import { expect, test } from "vitest"
import { renderHeadersFile } from "../../security-headers.ts"
import { headersFor, parseHeadersFile } from "./headers-file.ts"

test("overlapping rules combine, and a repeated name is comma-joined as on the Worker", () => {
	const rules = parseHeadersFile("/*\n  X-A: one\n  Cache-Control: no-cache\n/assets/a.js\n  Cache-Control: immutable\n")
	expect(Object.fromEntries(headersFor(rules, "/assets/a.js"))).toEqual({ "x-a": "one", "cache-control": "no-cache, immutable" })
	expect(Object.fromEntries(headersFor(rules, "/"))).toEqual({ "x-a": "one", "cache-control": "no-cache" })
})

test("the file the build emits parses", () => {
	const rules = parseHeadersFile(renderHeadersFile("preview", ["assets/a.js"]))
	expect(headersFor(rules, "/assets/a.js").get("x-robots-tag")).toBe("noindex")
})

test.each([
	["a placeholder", "/:slug\n  X-A: 1\n"],
	["a non-root splat", "/assets/*\n  X-A: 1\n"],
	["a detached header", "/*\n  ! X-A\n"],
	["a header before any path", "  X-A: 1\n"],
])("throws on %s", (_name, source) => {
	expect(() => parseHeadersFile(source)).toThrow(/_headers line/)
})
