import { mount } from "@vue/test-utils"
import { beforeEach, describe, expect, test, vi } from "vitest"
import { THEME_KEY } from "@/composables/useTheme"
import { TESTIDS } from "@/lib/testids"
import ThemeToggle from "./ThemeToggle.vue"

beforeEach(() => {
	localStorage.clear()
	document.documentElement.removeAttribute("theme")
	vi.stubGlobal("matchMedia", (query: string) => ({
		matches: false,
		media: query,
		addEventListener() {},
		removeEventListener() {},
	}))
})

describe("ThemeToggle", () => {
	test("renders the current mode and cycles + persists on click", async () => {
		const wrapper = mount(ThemeToggle)
		const btn = wrapper.find(`[data-testid="${TESTIDS.themeToggle}"]`)
		expect(btn.exists()).toBe(true)

		const before = btn.attributes("data-theme-mode")
		await btn.trigger("click")
		expect(btn.attributes("data-theme-mode")).not.toBe(before)
		expect(localStorage.getItem(THEME_KEY)).toBeTruthy()
		expect(document.documentElement.getAttribute("theme")).toBeTruthy()
	})

	test("exposes an accessible label that names the current theme", () => {
		const wrapper = mount(ThemeToggle)
		const btn = wrapper.find(`[data-testid="${TESTIDS.themeToggle}"]`)
		expect(btn.attributes("aria-label")).toMatch(/theme:/i)
	})
})
