/**
 * The page's response headers. One source for the built `_headers` file and `vite preview`, so a local
 * run serves what the Worker serves. Node-free on purpose: vite.config.ts, the build guard and tests
 * all import it.
 */

/** Which build this is. A preview is any Workers Builds branch other than production. */
export type Channel = "production" | "preview"

export const PRODUCTION_BRANCH = "main"

/** `WORKERS_CI_BRANCH` is set by Workers Builds only, so a local or CI build is production. */
export function channelOf(branch: string | undefined): Channel {
	return branch && branch !== PRODUCTION_BRANCH ? "preview" : "production"
}

// The page loads its own script, stylesheet, fonts and favicon, and nothing else. Trusted Types with
// no policy forbids every DOM HTML-string sink, which the runtime never uses.
const CSP = [
	"default-src 'none'",
	"script-src 'self'",
	"style-src 'self'",
	"img-src 'self'",
	"font-src 'self'",
	"base-uri 'none'",
	"form-action 'none'",
	"frame-ancestors 'none'",
	"require-trusted-types-for 'script'",
	"trusted-types 'none'",
].join("; ")

// Only names Chromium recognises: an unknown one logs a console error on every load.
const PERMISSIONS = ["accelerometer", "camera", "geolocation", "gyroscope", "magnetometer", "microphone", "payment", "usb"]
	.map((feature) => `${feature}=()`)
	.join(", ")

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
	"Content-Security-Policy": CSP,
	"Cross-Origin-Opener-Policy": "same-origin",
	"Permissions-Policy": PERMISSIONS,
	"Referrer-Policy": "strict-origin-when-cross-origin",
	// No includeSubDomains: the zone's other hosts keep their own policy.
	"Strict-Transport-Security": "max-age=31536000",
	"X-Content-Type-Options": "nosniff",
	"X-Frame-Options": "DENY",
}

/** Previews live at workers.dev hosts that search engines must not index. */
export const PREVIEW_HEADERS: Readonly<Record<string, string>> = { "X-Robots-Tag": "noindex" }

export const IMMUTABLE = "public, max-age=31536000, immutable"

/** Every header a response of this channel carries, whatever its path. */
export function pageHeaders(channel: Channel): Record<string, string> {
	return channel === "preview" ? { ...SECURITY_HEADERS, ...PREVIEW_HEADERS } : { ...SECURITY_HEADERS }
}

/**
 * The `_headers` file: the page headers on `/*`, plus one immutable cache rule per hashed file. A
 * rule per file, never `/assets/*`: a missing asset falls back to index.html, which must not be
 * cached for a year.
 */
export function renderHeadersFile(channel: Channel, hashedFiles: readonly string[]): string {
	const block = (path: string, headers: Record<string, string>) =>
		[path, ...Object.entries(headers).map(([name, value]) => `  ${name}: ${value}`)].join("\n")
	const rules = [
		block("/*", pageHeaders(channel)),
		...[...hashedFiles].sort().map((file) => block(`/${file}`, { "Cache-Control": IMMUTABLE })),
	]
	return `${rules.join("\n")}\n`
}
