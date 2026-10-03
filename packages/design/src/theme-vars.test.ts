/// <reference types="node" />
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "vitest"
import { collectStyleFiles, declaredVars, findUndefinedThemeVars, isOwnedToken } from "./theme-vars"

describe("undefined-var guard (design self-scan)", () => {
	test("every owned var referenced in @unleashed/design SFCs is declared in base.css", () => {
		const declared = declaredVars(join(process.cwd(), "src/base.css"))
		const files = collectStyleFiles(join(process.cwd(), "src"))
		const ghosts = findUndefinedThemeVars(files, declared)
		expect(ghosts).toEqual([])
	})

	test("classifies owned vs local namespaces", () => {
		expect(isOwnedToken("--ul-signal")).toBe(true)
		expect(isOwnedToken("--txt-primary")).toBe(true)
		expect(isOwnedToken("--red")).toBe(true)
		expect(isOwnedToken("--local-spacing")).toBe(false)
		expect(isOwnedToken("--my-component-x")).toBe(false)
	})

	test("reports an owned token built by interpolation, which it cannot resolve", () => {
		const dir = mkdtempSync(join(tmpdir(), "theme-vars-"))
		const file = join(dir, "Dynamic.vue")
		// biome-ignore lint/suspicious/noTemplateCurlyInString: the fixture is SFC source text
		writeFileSync(file, "<script setup>const c = `var(--txt-${props.color})`; const l = `var(--local-${x})`</script>")
		try {
			expect(findUndefinedThemeVars([file], new Set(["--txt-primary"])).map((g) => g.token)).toEqual(["--txt-"])
		} finally {
			rmSync(dir, { recursive: true })
		}
	})

	test("detects a ghost token against a known declared set", () => {
		const declared = new Set(["--ul-signal", "--txt-primary"])
		const ghosts = findUndefinedThemeVarsFromSource("a { color: var(--ul-signal); border-color: var(--ul-missing); }", declared)
		expect(ghosts).toEqual(["--ul-missing"])
	})
})

// Small inline variant so the detector is unit-tested without touching disk.
function findUndefinedThemeVarsFromSource(src: string, declared: Set<string>): string[] {
	const out: string[] = []
	for (const m of src.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)) {
		if (isOwnedToken(m[1]) && !declared.has(m[1])) out.push(m[1])
	}
	return out
}
