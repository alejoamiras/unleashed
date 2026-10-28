import { describe, expect, it } from "vitest"
import { LEGAL_DOCUMENTS } from "./index.ts"

/** Bidi controls and zero-width characters: they make the rendered text differ from what a reviewer reads. */
const HIDDEN = /[​-‏‪-‮⁦-⁩﻿]/

describe("legal document text", () => {
	it("carries no hidden characters", () => {
		for (const doc of LEGAL_DOCUMENTS) expect(HIDDEN.test(JSON.stringify(doc)), doc.id).toBe(false)
	})

	it("the hidden-character check catches a right-to-left override", () => {
		expect(HIDDEN.test("pay‮txt.exe")).toBe(true)
	})

	it("links every provider's policy over https, the only scheme a page renders as a link", () => {
		const rows = LEGAL_DOCUMENTS.flatMap((d) => d.sections.flatMap((s) => s.blocks)).flatMap((b) =>
			b.kind === "providers" ? b.rows : [],
		)
		expect(rows.length).toBeGreaterThan(0)
		for (const row of rows) expect(new URL(row.policyUrl).protocol, row.name).toBe("https:")
	})
})
