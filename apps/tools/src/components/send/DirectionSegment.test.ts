import { mount } from "@vue/test-utils"
import { describe, expect, it } from "vitest"
import { TESTIDS } from "@/lib/testids"
import DirectionSegment from "./DirectionSegment.vue"

const sel = (t: string) => `[data-testid="${t}"]`

describe("DirectionSegment", () => {
	it("a locked segment keeps the direction selected, disables both tabs and emits nothing", async () => {
		const w = mount(DirectionSegment, { props: { direction: "l2-to-l1", locked: true } })
		const tabs = w.findAll('[role="tab"]')
		expect(tabs.map((t) => t.attributes("aria-selected"))).toEqual(["false", "true"])
		expect(tabs.every((t) => t.attributes("disabled") !== undefined)).toBe(true)
		// test-utils never dispatches on a disabled element, so the guards are reached with it lifted.
		for (const t of tabs) t.element.removeAttribute("disabled")
		await tabs[0].trigger("click")
		await tabs[1].trigger("keydown.left")
		expect(w.emitted("update:direction")).toBeUndefined()

		await w.setProps({ locked: false })
		await tabs[0].trigger("click")
		expect(w.emitted("update:direction")).toEqual([["l1-to-l2"]])
	})

	it("a testids override names the root only, so no send testid is rendered twice", () => {
		const w = mount(DirectionSegment, { props: { direction: "l1-to-l2", locked: true, testids: { root: TESTIDS.stepperDirection } } })
		expect(w.attributes("data-testid")).toBe(TESTIDS.stepperDirection)
		for (const id of [TESTIDS.sendDirection, TESTIDS.sendDirectionDeposit, TESTIDS.sendDirectionExit]) {
			expect(w.find(sel(id)).exists()).toBe(false)
		}
		expect(w.findAll('[role="tab"]').map((t) => t.attributes("data-testid"))).toEqual([undefined, undefined])
	})
})
