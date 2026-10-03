/// <reference types="node" />
import { join } from "node:path"
import { collectStyleFiles, declaredVars, findUndefinedThemeVars } from "@unleashed/design/testing"
import { describe, expect, test } from "vitest"

// The design package's base.css declares the canonical token set.
const DESIGN_BASE_CSS = join(process.cwd(), "../../packages/design/src/base.css")

/**
 * Every design-system `var(--token)` a tools component reads must be declared in base.css: an
 * undeclared one resolves to its fallback, which suits one theme at best.
 */
describe("undefined-var guard (tools)", () => {
	test("no tools SFC references an owned --token that is undeclared in base.css", () => {
		const declared = declaredVars(DESIGN_BASE_CSS)
		const files = collectStyleFiles(join(process.cwd(), "src"))
		const ghosts = findUndefinedThemeVars(files, declared)
		const report = ghosts.map((g) => `${g.token} in ${g.file.replace(process.cwd(), "")}`)
		expect(report).toEqual([])
	})
})
