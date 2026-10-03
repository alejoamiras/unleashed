import { mount } from "@vue/test-utils"
import { describe, expect, test } from "vitest"
import Icon from "./Icon.vue"
import { ICONS } from "./icons"

describe("Icon", () => {
	test("draws every path of the named glyph at the requested size, filled and pixel-crisp", () => {
		const w = mount(Icon, { props: { name: "download", size: "24" } })
		expect(w.findAll("path").map((p) => p.attributes("d"))).toEqual([...ICONS.download.d])
		expect(ICONS.download.d.length).toBeGreaterThan(1)
		expect(w.attributes("width")).toBe("24")
		expect(w.attributes("height")).toBe("24")
		expect(w.attributes("fill")).toBe("currentColor")
		expect(w.attributes("shape-rendering")).toBe("crispEdges")
	})

	test("renders at 12 when no size is given", () => {
		const w = mount(Icon, { props: { name: "check" } })
		expect(w.attributes("width")).toBe("12")
		expect(w.attributes("height")).toBe("12")
	})

	test("keeps chevron as the name for chevron-down", () => {
		const w = mount(Icon, { props: { name: "chevron" } })
		expect(w.findAll("path").map((p) => p.attributes("d"))).toEqual([...ICONS["chevron-down"].d])
	})

	test("is hidden from assistive tech unless labelled, then it is a named image", () => {
		const hidden = mount(Icon, { props: { name: "check" } })
		expect(hidden.attributes("aria-hidden")).toBe("true")
		expect(hidden.attributes("role")).toBeUndefined()
		expect(hidden.attributes("aria-label")).toBeUndefined()

		const named = mount(Icon, { props: { name: "check", label: "Done" } })
		expect(named.attributes("role")).toBe("img")
		expect(named.attributes("aria-label")).toBe("Done")
		expect(named.attributes("aria-hidden")).toBeUndefined()
	})

	test("maps a text colour to its token, or takes the surrounding colour when none is given", () => {
		expect((mount(Icon, { props: { name: "check", color: "secondary" } }).element as SVGElement).style.color).toBe("var(--ul-ink-2)")
		expect((mount(Icon, { props: { name: "check" } }).element as SVGElement).style.color).toBe("")
	})

	test("rotates by the given degrees and not at all by default", () => {
		expect((mount(Icon, { props: { name: "chevron", rotate: "180" } }).element as SVGElement).style.transform).toBe("rotate(180deg)")
		expect((mount(Icon, { props: { name: "chevron" } }).element as SVGElement).style.transform).toBe("")
	})
})
