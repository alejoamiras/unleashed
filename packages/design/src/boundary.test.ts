import { describe, expect, test } from "vitest"
import biome from "../../../biome.json"

/**
 * Belt-and-suspenders for the `@unleashed/design` platform-agnostic floor:
 *  1. No chrome.* reaches the source, including the indirections Biome's `noRestrictedGlobals`
 *     misses: dot + bracket access on any host global (`window`/`self`/`globalThis`) +
 *     `webextension-polyfill`.
 *  2. The Biome floor for `packages/design/src/**` still bans `@unleashed/*` + `chrome` — so a PR can't
 *     silently weaken the boundary in the same diff that exploits it.
 *  3. No `vue-router` import — router purity is a locked design-system decision (router seams live in
 *     the consuming app's wrappers, never in the package).
 *  4. No raw-HTML sink (`v-html`/`innerHTML`/`domPropsInnerHTML`) — a tripwire on the wallet's
 *     primitive surface. This is belt-and-suspenders, NOT the primary XSS control (it can't see
 *     render-function sinks or helper indirection); the primary control is the API design (no
 *     primitive takes an HTML-string prop) + review. A regex tripwire still raises the bar cheaply.
 *  5. The Biome `ui`-layer rule (`packages/design/src/ui/**`) bans importing `composite` (L3).
 */

type BiomeOverride = {
	includes?: string[]
	linter?: {
		rules?: {
			style?: {
				noRestrictedImports?: { options?: { patterns?: Array<{ group?: string[] }> } }
				noRestrictedGlobals?: { options?: { deniedGlobals?: Record<string, string> } }
			}
		}
	}
}

const sources = import.meta.glob("./**/*.{ts,tsx,js,mjs,cjs,vue}", { query: "?raw", eager: true, import: "default" }) as Record<
	string,
	string
>

describe("@unleashed/design platform-agnostic boundary", () => {
	test("source has no chrome.* access (direct or via window/globalThis/webextension-polyfill)", () => {
		const banned: Array<[string, RegExp]> = [
			["chrome.", /\bchrome\s*\./],
			// dot access on any host global: window/self/globalThis.chrome
			["host.chrome (dot)", /\b(?:window|self|globalThis)\s*\.\s*chrome\b/],
			// bracket access on any host global: window/self/globalThis["chrome"]
			["host[chrome] (bracket)", /\b(?:window|self|globalThis)\s*\[\s*["']chrome["']\s*\]/],
			["webextension-polyfill", /webextension-polyfill/],
		]
		const offenders: string[] = []
		for (const [path, src] of Object.entries(sources)) {
			if (path.includes(".test.")) continue
			for (const [label, re] of banned) if (re.test(src)) offenders.push(`${path}: ${label}`)
		}
		expect(offenders).toEqual([])
	})

	test("biome floor for packages/design/src/** still bans @unleashed/* and chrome", () => {
		const overrides = (biome as unknown as { overrides: BiomeOverride[] }).overrides
		const floor = overrides.find((o) => o.includes?.includes("packages/design/src/**"))
		expect(floor, "floor override for packages/design/src/** must exist").toBeDefined()

		const style = floor?.linter?.rules?.style
		const patterns = style?.noRestrictedImports?.options?.patterns ?? []
		expect(patterns.some((p) => p.group?.includes("@unleashed/*"))).toBe(true)
		expect(style?.noRestrictedGlobals?.options?.deniedGlobals?.chrome).toBeTruthy()
	})

	test("source imports no vue-router (router purity is a locked design-system decision)", () => {
		const offenders: string[] = []
		for (const [path, src] of Object.entries(sources)) {
			if (path.includes(".test.")) continue
			if (/\bfrom\s+["']vue-router["']|(?:require|import)\(\s*["']vue-router["']\s*\)/.test(src)) offenders.push(path)
		}
		expect(offenders).toEqual([])
	})

	test("source has no raw-HTML sink (v-html / innerHTML) — wallet-primitive XSS tripwire", () => {
		const banned: Array<[string, RegExp]> = [
			["v-html", /\bv-html\b/],
			["innerHTML", /\binnerHTML\b/],
			["domPropsInnerHTML", /\bdomPropsInnerHTML\b/],
		]
		const offenders: string[] = []
		for (const [path, src] of Object.entries(sources)) {
			if (path.includes(".test.")) continue
			for (const [label, re] of banned) if (re.test(src)) offenders.push(`${path}: ${label}`)
		}
		expect(offenders).toEqual([])
	})

	test("biome ui-layer rule for packages/design/src/ui/** bans composite + @unleashed/* + chrome", () => {
		const overrides = (biome as unknown as { overrides: BiomeOverride[] }).overrides
		const ui = overrides.find((o) => o.includes?.includes("packages/design/src/ui/**"))
		expect(ui, "ui-layer override for packages/design/src/ui/** must exist").toBeDefined()

		const style = ui?.linter?.rules?.style
		const patterns = style?.noRestrictedImports?.options?.patterns ?? []
		expect(patterns.some((p) => p.group?.includes("@unleashed/*"))).toBe(true)
		expect(patterns.some((p) => p.group?.some((g) => g.includes("composite")))).toBe(true)
		expect(style?.noRestrictedGlobals?.options?.deniedGlobals?.chrome).toBeTruthy()
	})
})
