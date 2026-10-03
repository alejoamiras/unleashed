import { mount } from "@vue/test-utils"
import { describe, expect, test } from "vitest"
import BusyPixels from "./BusyPixels.vue"

describe("BusyPixels", () => {
	test("is a labelled status drawn as three pixels hidden from assistive tech", () => {
		const w = mount(BusyPixels, { props: { label: "Dripping" } })
		expect(w.attributes("role")).toBe("status")
		expect(w.attributes("aria-label")).toBe("Dripping")
		const pixels = w.findAll("span > span")
		expect(pixels).toHaveLength(3)
		for (const p of pixels) expect(p.attributes("aria-hidden")).toBe("true")
		expect(mount(BusyPixels).attributes("aria-label")).toBe("Loading")
	})
})
