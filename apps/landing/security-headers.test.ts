import { describe, expect, test } from "vitest"
import { channelOf, IMMUTABLE, renderHeadersFile, SECURITY_HEADERS } from "./security-headers.ts"

describe("security headers", () => {
	test("the CSP denies by default and never allows an unsafe or remote source", () => {
		const csp = SECURITY_HEADERS["Content-Security-Policy"]
		expect(csp.startsWith("default-src 'none'")).toBe(true)
		expect(csp).not.toMatch(/'unsafe-|https?:|data:|\*/)
		expect(csp).toContain("frame-ancestors 'none'")
		expect(csp).toContain("require-trusted-types-for 'script'")
	})

	test("only a Workers Builds branch other than main is a preview", () => {
		expect(channelOf(undefined)).toBe("production")
		expect(channelOf("")).toBe("production")
		expect(channelOf("main")).toBe("production")
		expect(channelOf("worktree-landing")).toBe("preview")
	})

	test("_headers caches each hashed file, never a wildcard, and marks previews noindex", () => {
		const production = renderHeadersFile("production", ["assets/b.css", "assets/a.js"])
		expect(production.split("\n").filter((line) => !line.startsWith(" "))).toEqual(["/*", "/assets/a.js", "/assets/b.css", ""])
		expect(production).toContain(`/assets/a.js\n  Cache-Control: ${IMMUTABLE}`)
		expect(production).not.toContain("/assets/*")
		expect(production).not.toContain("X-Robots-Tag")
		expect(renderHeadersFile("preview", [])).toContain("  X-Robots-Tag: noindex")
	})
})
