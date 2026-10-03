import { mount } from "@vue/test-utils"
import { describe, expect, it } from "vitest"
import { TESTIDS } from "@/lib/testids"
import DockStrip from "./DockStrip.vue"

const sel = (t: string) => `[data-testid="${t}"]`

describe("DockStrip", () => {
	it("names itself Activity; its chevron says whether the panel it controls is expanded", async () => {
		const w = mount(DockStrip, { props: { count: 2, controls: "panel" } })
		expect(w.get(sel(TESTIDS.dockStrip)).attributes("aria-label")).toBe("Activity")
		const btn = w.get(sel(TESTIDS.dockOpen))
		expect(btn.attributes("aria-expanded")).toBe("false")
		expect(btn.attributes("aria-controls")).toBeUndefined()
		expect(w.get(sel(TESTIDS.dockBadge)).text()).toBe("2")
		await w.setProps({ open: true })
		expect(btn.attributes("aria-expanded")).toBe("true")
		expect(btn.attributes("aria-controls")).toBe("panel")
		expect(w.find(sel(TESTIDS.dockBadge)).exists()).toBe(false)
	})
})
