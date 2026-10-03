import { mount } from "@vue/test-utils"
import { describe, expect, test } from "vitest"
import Flex from "./Flex.vue"

const vars = (w: ReturnType<typeof mount>) => (w.element as HTMLElement).style

describe("Flex", () => {
	test("renders the requested tag around its slot", () => {
		const w = mount(Flex, { props: { tag: "section" }, slots: { default: "<b>x</b>" } })
		expect(w.element.tagName).toBe("SECTION")
		expect(w.html()).toContain("<b>x</b>")
	})

	test("maps placement names and string gaps to CSS values", () => {
		const w = mount(Flex, { props: { direction: "column", align: "center", justify: "between", wrap: "wrap", gap: "12" } })
		expect(vars(w).getPropertyValue("--flex-direction")).toBe("column")
		expect(vars(w).getPropertyValue("--flex-align")).toBe("center")
		expect(vars(w).getPropertyValue("--flex-justify")).toBe("space-between")
		expect(vars(w).getPropertyValue("--flex-wrap")).toBe("wrap")
		expect(vars(w).getPropertyValue("--flex-gap")).toBe("12px")
	})

	test("sets every variable even when no prop is given, so nothing inherits from an outer Flex", () => {
		const w = mount(Flex)
		expect(vars(w).getPropertyValue("--flex-direction")).toBe("row")
		expect(vars(w).getPropertyValue("--flex-align")).toBe("normal")
		expect(vars(w).getPropertyValue("--flex-justify")).toBe("normal")
		expect(vars(w).getPropertyValue("--flex-wrap")).toBe("nowrap")
		expect(vars(w).getPropertyValue("--flex-gap")).toBe("0px")
	})

	test("passes a caller's class and test id through", () => {
		const w = mount(Flex, { attrs: { class: "links", "data-testid": "flex" } })
		expect(w.classes()).toContain("links")
		expect(w.attributes("data-testid")).toBe("flex")
	})
})
