import { describe, expect, it } from "vitest"
import { PRIVACY } from "./privacy"
import { TERMS } from "./terms"

/** Bidi controls and zero-width characters: they make the rendered text differ from what a reviewer reads. */
const HIDDEN = /[​-‏‪-‮⁦-⁩﻿]/

describe("legal document text", () => {
	it("carries no hidden characters", () => {
		for (const doc of [TERMS, PRIVACY]) expect(HIDDEN.test(JSON.stringify(doc)), doc.id).toBe(false)
	})

	it("the hidden-character check catches a right-to-left override", () => {
		expect(HIDDEN.test("pay‮txt.exe")).toBe(true)
	})
})
