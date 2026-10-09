/**
 * The build guard's rules over a built dist/, as pure functions of its files. Imports nothing but
 * node:crypto and the content file, because a keyed deploy runs this code beside a Cloudflare token.
 */
import { createHash } from "node:crypto"
import { CANONICAL, LINKS } from "../src/content.ts"

/** dist/ as `relative path → bytes`. */
export type Dist = ReadonlyMap<string, Uint8Array>

const MAX_JS_BYTES = 40_000
const MAX_NON_FONT_BYTES = 200_000
const FONT_FILES = ["AtkinsonHyperlegibleNext", "AtkinsonHyperlegibleMono", "SixtyfourConvergence-subset"]
const ALLOWED_URLS = new Set<string>([...Object.values(LINKS), CANONICAL])
/*
 * The link rules catch a link nobody meant to ship. They are not the tamper boundary: code that runs
 * at build time could navigate from the script bundle, which no HTML check sees. The digest a deploy
 * is checked against is that boundary.
 */
// Anything else, an entity, a scheme in any case or a `//` host included, is refused rather than decoded.
const LOCAL_PATH = /^\/(?!\/)[\w.~/-]*$/
// An attribute starts after whitespace, a `/` or a closing quote, as the HTML tokenizer reads it.
const DESTINATION = /[\s/"'](href|xlink:href|src|srcset|action|formaction|poster|data|content)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi
// A `content` value is prose unless it could name a place.
const URL_LIKE = /[:&\\]|\/\//
// The renderer escapes with these five only, so no other reference can spell a `/` or a `:`.
const FOREIGN_ENTITY = /&(?!(?:amp|lt|gt|quot|#39);)/
const HTTP_EQUIV = /[\s/"']http-equiv\s*=/i

const text = (dist: Dist, path: string) => new TextDecoder().decode(dist.get(path) ?? new Uint8Array())
const bytesOf = (dist: Dist, test: (path: string) => boolean) =>
	[...dist].filter(([path]) => test(path)).reduce((sum, [, bytes]) => sum + bytes.byteLength, 0)

/** The `/*` rule's headers from a `_headers` file, names lower-cased. */
export function wildcardHeaders(headersFile: string): Map<string, string> {
	const headers = new Map<string, string>()
	let inWildcard = false
	for (const line of headersFile.split("\n")) {
		if (!line.startsWith(" ")) inWildcard = line.trim() === "/*"
		else if (inWildcard) {
			const at = line.indexOf(":")
			headers.set(line.slice(0, at).trim().toLowerCase(), line.slice(at + 1).trim())
		}
	}
	return headers
}

function checkPresence(dist: Dist): string[] {
	return ["index.html", "_headers", "build.json"].filter((path) => !dist.has(path)).map((path) => `missing ${path}`)
}

function checkCsp(headers: Map<string, string>): string[] {
	const csp = headers.get("content-security-policy") ?? ""
	const errors: string[] = []
	if (!csp.startsWith("default-src 'none'")) errors.push(`CSP must start with default-src 'none': '${csp}'`)
	if (/'unsafe-/.test(csp)) errors.push("CSP allows an 'unsafe-' source")
	if (/\bhttps?:/.test(csp)) errors.push("CSP names a scheme or host source")
	return errors
}

function checkHtml(html: string): string[] {
	const errors: string[] = []
	if (/<script(?![^>]*\ssrc=)[^>]*>/.test(html)) errors.push("index.html has an inline <script>")
	if (/\sstyle=/.test(html)) errors.push("index.html has a style= attribute")
	if (HTTP_EQUIV.test(html)) errors.push("index.html has an http-equiv meta")
	if (FOREIGN_ENTITY.test(html)) errors.push("index.html has a character reference the renderer never emits")
	for (const [, name, ...quoted] of html.matchAll(DESTINATION)) {
		const value = quoted.find((v) => v !== undefined) ?? ""
		if (ALLOWED_URLS.has(value)) continue
		if (name.toLowerCase() === "content" ? URL_LIKE.test(value) : !LOCAL_PATH.test(value))
			errors.push(`index.html links outside LINKS: ${name}=${value}`)
	}
	return errors
}

function checkFonts(dist: Dist): string[] {
	const errors = FONT_FILES.filter((font) => ![...dist.keys()].some((p) => p.startsWith(`assets/${font}-`) && p.endsWith(".woff2"))).map(
		(font) => `font file missing from assets/: ${font}`,
	)
	for (const [path] of dist) {
		if (!path.endsWith(".css")) continue
		for (const [face] of text(dist, path).matchAll(/@font-face\s*{[^}]*}/g)) {
			if (/url\(\s*["']?data:/.test(face)) errors.push(`${path} inlines a font as a data: URL`)
		}
	}
	return errors
}

function checkSizes(dist: Dist): string[] {
	const js = bytesOf(dist, (p) => p.endsWith(".js") && p !== "theme-boot.js")
	const nonFont = bytesOf(dist, (p) => !p.endsWith(".woff2"))
	return [
		...(js > MAX_JS_BYTES ? [`JavaScript is ${js} bytes, over ${MAX_JS_BYTES}`] : []),
		...(nonFont > MAX_NON_FONT_BYTES ? [`dist/ without fonts is ${nonFont} bytes, over ${MAX_NON_FONT_BYTES}`] : []),
	]
}

/** build.json's identity, matched against the HTML and the channel's markers. */
function checkIdentity(dist: Dist, headers: Map<string, string>): string[] {
	const meta = JSON.parse(text(dist, "build.json") || "{}") as { buildId?: string; channel?: string }
	const html = text(dist, "index.html")
	const errors: string[] = []
	if (!meta.buildId || !html.includes(`<meta name="unleashed-build" content="${meta.buildId}">`))
		errors.push("build id missing or not in index.html")
	const preview = meta.channel === "preview"
	if (meta.channel !== "production" && !preview) errors.push(`unknown channel '${meta.channel}'`)
	if (preview !== headers.has("x-robots-tag")) errors.push("X-Robots-Tag must be sent by previews only")
	if (preview !== html.includes('<meta name="robots" content="noindex">')) errors.push("the noindex meta must be in previews only")
	return errors
}

/** Every rule the build breaks; empty when dist/ is shippable. */
export function checkDist(dist: Dist): string[] {
	const missing = checkPresence(dist)
	if (missing.length) return missing
	const headers = wildcardHeaders(text(dist, "_headers"))
	return [
		...checkCsp(headers),
		...checkHtml(text(dist, "index.html")),
		...checkFonts(dist),
		...checkSizes(dist),
		...checkIdentity(dist, headers),
	]
}

export function channelOfDist(dist: Dist): string | undefined {
	return (JSON.parse(text(dist, "build.json") || "{}") as { channel?: string }).channel
}

/**
 * sha256 over every path and its bytes, in path order: names the exact artifact a deploy ships. Each
 * part is length-prefixed, so no file's bytes can pose as a file boundary.
 */
export function distDigest(dist: Dist): string {
	const hash = createHash("sha256")
	for (const path of [...dist.keys()].sort()) {
		const name = new TextEncoder().encode(path)
		const bytes = dist.get(path) as Uint8Array
		hash.update(`${name.byteLength}:`).update(name).update(`:${bytes.byteLength}:`).update(bytes)
	}
	return hash.digest("hex")
}
