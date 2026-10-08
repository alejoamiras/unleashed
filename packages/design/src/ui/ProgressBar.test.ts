import { mount } from "@vue/test-utils"
import { describe, expect, test } from "vitest"
import ProgressBar from "./ProgressBar.vue"

describe("ProgressBar", () => {
	test("without a value it is indeterminate: named by its label, no aria-valuenow, 14px tall", () => {
		const w = mount(ProgressBar, { props: { label: "SIGNAL drip progress" } })
		expect(w.attributes("role")).toBe("progressbar")
		expect(w.attributes("aria-label")).toBe("SIGNAL drip progress")
		expect(w.attributes("aria-valuenow")).toBeUndefined()
		expect(w.attributes("style")).toContain("height: 14px")
	})

	test("a value sets aria-valuenow in percent and the fill's width", () => {
		const w = mount(ProgressBar, { props: { label: "Bridge progress", value: 0.45, height: 18 } })
		expect(w.attributes("aria-valuenow")).toBe("45")
		expect(w.attributes("aria-valuemin")).toBe("0")
		expect(w.attributes("aria-valuemax")).toBe("100")
		expect(w.get("span").attributes("style")).toContain("width: 45%")
		expect(w.attributes("style")).toContain("height: 18px")
	})

	test("at zero it draws only the fill's ink edge, where the run starts", () => {
		const w = mount(ProgressBar, { props: { label: "Bridge progress", value: 0 } })
		expect(w.attributes("aria-valuenow")).toBe("0")
		expect(w.get("span").attributes("style")).toContain("width: 0%")
	})
})
