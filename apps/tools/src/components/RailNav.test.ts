import { mount } from "@vue/test-utils"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { __resetShellForTests, useShell } from "@/composables/useShell"
import { TESTIDS } from "@/lib/testids"
import RailNav from "./RailNav.vue"

const sel = (t: string) => `[data-testid="${t}"]`

describe("RailNav", () => {
	beforeEach(() => __resetShellForTests())
	afterEach(() => vi.unstubAllGlobals())

	it("is one roving tablist: the active section is the only Tab stop", () => {
		const w = mount(RailNav, { props: { activityCount: 0 } })
		expect(w.get(sel(TESTIDS.tabs)).attributes("role")).toBe("tablist")
		expect(w.get(sel(TESTIDS.tabSend)).attributes("tabindex")).toBe("0")
		expect(w.get(sel(TESTIDS.tabSend)).text()).toBe("Bridge")
		expect(w.get(sel(TESTIDS.tabDrip)).attributes("tabindex")).toBe("-1")
		expect(w.get(sel(TESTIDS.tabActivity)).attributes("aria-selected")).toBe("false")
	})

	it("clicking switches the shell's section; arrows walk the list and wrap", async () => {
		const w = mount(RailNav, { props: { activityCount: 0 }, attachTo: document.body })
		await w.get(sel(TESTIDS.tabDrip)).trigger("click")
		expect(useShell().section.value).toBe("drip")
		await w.get(sel(TESTIDS.tabSend)).trigger("keydown", { key: "ArrowUp" })
		expect(useShell().section.value).toBe("addresses")
		expect(document.activeElement).toBe(w.get(sel(TESTIDS.tabAddresses)).element)
		await w.get(sel(TESTIDS.tabAddresses)).trigger("keydown", { key: "ArrowRight" })
		expect(useShell().section.value).toBe("send")
		w.unmount()
	})

	it("shows the needs-you count as a chip named in words, and nothing when it is zero", () => {
		const idle = mount(RailNav, { props: { activityCount: 0 } }).get(sel(TESTIDS.tabActivity))
		expect(idle.text()).toBe("Activity")
		expect(idle.find(".sr-only").exists()).toBe(false)
		const tab = mount(RailNav, { props: { activityCount: 2 } }).get(sel(TESTIDS.tabActivity))
		const chip = tab.get(".count")
		expect(chip.text()).toBe("2")
		expect(chip.attributes("aria-hidden")).toBe("true")
		expect(tab.get(".sr-only").text()).toBe(", 2 needs you")
	})

	it("announces horizontal once it renders as the top row", () => {
		vi.stubGlobal("matchMedia", (query: string) => ({
			matches: query === "(max-width: 760px)",
			media: query,
			addEventListener() {},
			removeEventListener() {},
		}))
		expect(
			mount(RailNav, { props: { activityCount: 0 } })
				.get(sel(TESTIDS.tabs))
				.attributes("aria-orientation"),
		).toBe("horizontal")
	})
})
