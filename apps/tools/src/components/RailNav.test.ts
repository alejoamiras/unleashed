import { mount } from "@vue/test-utils"
import { beforeEach, describe, expect, it } from "vitest"
import { nextTick } from "vue"
import { __resetShellForTests, useShell } from "@/composables/useShell"
import { TESTIDS } from "@/lib/testids"
import RailNav from "./RailNav.vue"

const sel = (t: string) => `[data-testid="${t}"]`

describe("RailNav", () => {
	beforeEach(() => __resetShellForTests())

	it("is a nav of links to each section's path, the current one marked as the page", () => {
		const w = mount(RailNav, { props: { activityCount: 0 } })
		expect(w.get(sel(TESTIDS.tabs)).element.tagName).toBe("NAV")
		const links = [TESTIDS.tabSend, TESTIDS.tabDrip, TESTIDS.tabActivity, TESTIDS.tabAddresses].map((t) => w.get(sel(t)))
		expect(links.map((l) => l.attributes("href"))).toEqual(["/bridge", "/faucet", "/activity", "/addresses"])
		expect(links.map((l) => l.attributes("aria-current"))).toEqual(["page", undefined, undefined, undefined])
		expect(links[0]?.text()).toBe("Bridge")
	})

	it("a plain click switches the section in place and marks the new page", async () => {
		const w = mount(RailNav, { props: { activityCount: 0 } })
		const click = new MouseEvent("click", { bubbles: true, cancelable: true })
		w.get(sel(TESTIDS.tabDrip)).element.dispatchEvent(click)
		await nextTick()
		expect(click.defaultPrevented).toBe(true)
		expect(useShell().section.value).toBe("drip")
		expect(w.get(sel(TESTIDS.tabDrip)).attributes("aria-current")).toBe("page")
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
})
