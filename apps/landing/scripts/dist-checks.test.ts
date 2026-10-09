import { describe, expect, test } from "vitest"
import { renderHeadersFile } from "../security-headers.ts"
import { checkDist, type Dist, distDigest } from "./dist-checks.ts"

const bytes = (value: string) => new TextEncoder().encode(value)
const BUILD = "0.1.0+0123abcd"
const HTML = `<!doctype html><head><script src="/theme-boot.js"></script><script type="module" crossorigin src="/assets/index-x.js"></script><meta name="unleashed-build" content="${BUILD}"></head><body><a href="https://github.com/alejoamiras/unleashed">x</a></body>`
const FONTS = ["AtkinsonHyperlegibleNext-a", "AtkinsonHyperlegibleMono-b", "SixtyfourConvergence-subset-c"]

/** A minimal production dist/ that every rule accepts; each case breaks exactly one thing. */
function dist(overrides: Record<string, string> = {}): Map<string, Uint8Array> {
	const files: Record<string, string> = {
		"index.html": HTML,
		_headers: renderHeadersFile("production", []),
		"build.json": JSON.stringify({ buildId: BUILD, channel: "production" }),
		"assets/index-x.css": `@font-face{src:url(/assets/${FONTS[0]}.woff2)}`,
		...Object.fromEntries(FONTS.map((font) => [`assets/${font}.woff2`, "font"])),
		...overrides,
	}
	return new Map(Object.entries(files).map(([path, value]) => [path, bytes(value)]))
}

describe("build guard", () => {
	test("accepts a shippable dist", () => {
		expect(checkDist(dist())).toEqual([])
	})

	test.each([
		["an inline script", { "index.html": HTML.replace("<body>", "<body><script>alert(1)</script>") }, "inline <script>"],
		["a style attribute", { "index.html": HTML.replace("<body>", '<body style="color:red">') }, "style= attribute"],
		["a link outside LINKS", { "index.html": HTML.replace("github.com/alejoamiras", "github.com/someone-else") }, "outside LINKS"],
		["a data: font", { "assets/index-x.css": "@font-face{src:url(data:font/woff2;base64,AAAA)}" }, "data: URL"],
		["an unsafe CSP", { _headers: "/*\n  Content-Security-Policy: default-src 'none'; script-src 'unsafe-inline'\n" }, "'unsafe-'"],
		["a preview marker in production", { _headers: renderHeadersFile("preview", []) }, "X-Robots-Tag"],
		["a build id the HTML lacks", { "build.json": JSON.stringify({ buildId: "0.1.0+ffffffff", channel: "production" }) }, "build id"],
	])("rejects %s", (_name, overrides, message) => {
		expect(checkDist(dist(overrides)).join("\n")).toContain(message)
	})

	test("the digest names the exact artifact", () => {
		const base: Dist = dist()
		expect(distDigest(base)).toBe(distDigest(dist()))
		expect(distDigest(dist({ "favicon.svg": "<svg/>" }))).not.toBe(distDigest(base))
		expect(distDigest(dist({ "index.html": `${HTML} ` }))).not.toBe(distDigest(base))
	})
})
