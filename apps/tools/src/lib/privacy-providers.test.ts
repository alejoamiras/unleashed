import { PRIVACY } from "@unleashed/legal"
import { describe, expect, it } from "vitest"
import { MAINNET_TARGET, type ToolsTarget } from "./network-targets"

/**
 * Every origin a target's build may reach: the CSP's sources other than keywords, `data:` and `blob:`, and
 * the endpoints the code calls. A wildcard source stays as written; a host-only or scheme-only source
 * throws, so one this cannot name fails the test. Wallet-routed calls and request contents are invisible.
 */
function reachedOrigins(target: ToolsTarget): Set<string> {
	const csp = target.cspConnectSrc
		.split(/\s+/)
		.filter((source) => source && !/^'.*'$/.test(source) && source !== "data:" && source !== "blob:")
	const endpoints = [
		target.nodeUrl,
		...Object.values(target.readRpcUrls).flat(),
		target.acrossApiUrl ?? "",
		...(target.webWalletUrls ?? []),
	]
	return new Set([...csp, ...endpoints.filter(Boolean)].map((url) => (url.includes("*") ? url : new URL(url).origin)))
}

const rows = PRIVACY.sections.flatMap((s) => s.blocks).flatMap((b) => (b.kind === "providers" ? b.rows : []))

describe("the Privacy Policy's providers", () => {
	it("name exactly the origins the mainnet build reaches", () => {
		expect(new Set(rows.flatMap((r) => (r.origin ? [r.origin] : [])))).toEqual(reachedOrigins(MAINNET_TARGET))
	})

	it("always include the host, which the build never calls", () => {
		expect(rows.some((r) => r.origin === null)).toBe(true)
	})

	it("would miss an origin added to the target, and ignore data: and blob:", () => {
		expect(reachedOrigins({ ...MAINNET_TARGET, cspConnectSrc: "'self' data: blob:" })).toEqual(new Set())
		const widened = { ...MAINNET_TARGET, cspConnectSrc: "'self' data: blob: https://rpc.example/v1" }
		expect(reachedOrigins(widened)).toEqual(new Set(["https://rpc.example"]))
		expect(() => reachedOrigins({ ...MAINNET_TARGET, cspConnectSrc: "'self' rpc.example" })).toThrow()
	})
})
