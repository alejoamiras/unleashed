import { mount } from "@vue/test-utils"
import { describe, expect, it } from "vitest"
import EmojiGrid from "./EmojiGrid.vue"

// Literal testids — the component takes them as props, with no app registry.
const gridId = "fa-emoji-grid"
const cellId = (i: number) => `fa-emoji-cell-${i}`
const NINE = ["🟢", "🔵", "🟡", "🟣", "🔴", "⚪", "⚫", "🟠", "🟤"]

describe("EmojiGrid", () => {
	it("renders one .cell per passed cell", () => {
		const w = mount(EmojiGrid, { props: { cells: NINE } })
		expect(w.findAll(".cell")).toHaveLength(9)
	})

	it("renders the cell contents in order", () => {
		const cells = mount(EmojiGrid, { props: { cells: NINE } }).findAll(".cell")
		expect(cells[0].text()).toBe("🟢")
		expect(cells[8].text()).toBe("🟤")
	})

	it("applies the per-cell testid via the cellTestId prop", () => {
		const w = mount(EmojiGrid, { props: { cells: NINE, cellTestId: cellId } })
		for (let i = 0; i < 9; i++) {
			expect(w.find(`[data-testid="${cellId(i)}"]`).exists()).toBe(true)
		}
	})

	it("applies the grid testid via the testId prop", () => {
		const w = mount(EmojiGrid, { props: { cells: NINE, testId: gridId } })
		expect(w.get(`[data-testid="${gridId}"]`).classes()).toContain("emoji-grid")
	})

	it("omits all data-testid attributes when no testid props are given", () => {
		const w = mount(EmojiGrid, { props: { cells: NINE } })
		expect(w.find("[data-testid]").exists()).toBe(false)
	})

	it("renders empty cells as blanks", () => {
		const cells = mount(EmojiGrid, { props: { cells: ["🟢", "", ""] } }).findAll(".cell")
		expect(cells).toHaveLength(3)
		expect(cells[1].text()).toBe("")
	})

	it("carries role=img + an accessible name", () => {
		const root = mount(EmojiGrid, { props: { cells: NINE, testId: gridId } }).get(`[data-testid="${gridId}"]`)
		expect(root.attributes("role")).toBe("img")
		expect(root.attributes("aria-label")).toMatch(/verification/i)
	})

	it("reacts to cells prop changes", async () => {
		const w = mount(EmojiGrid, { props: { cells: NINE } })
		await w.setProps({ cells: ["🦊"] })
		expect(w.findAll(".cell")).toHaveLength(1)
		expect(w.findAll(".cell")[0].text()).toBe("🦊")
	})
})
