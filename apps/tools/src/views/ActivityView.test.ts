import { mount } from "@vue/test-utils"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { defineComponent, ref } from "vue"
import { __resetShellForTests, useShell } from "@/composables/useShell"
import { TESTIDS } from "@/lib/testids"

const placeholder = vi.hoisted(() => ({ value: false }))
vi.mock("@/contracts/bridge-generation", () => ({
	get IS_PLACEHOLDER() {
		return placeholder.value
	},
}))

const records = ref<unknown[]>([])
vi.mock("@/composables/useBridgeJournal", () => ({ useBridgeJournal: () => ({ records }) }))

/** The list itself is under test elsewhere; here it only has to expose its `#empty` slot and echo
 *  the props the view is responsible for. */
const JournalStub = defineComponent({
	name: "BridgeJournal",
	props: ["source", "title", "highlightedId"],
	template: `<div data-testid="${TESTIDS.journal}" :data-source="source" :data-highlighted="highlightedId ?? ''"><slot name="empty" /></div>`,
})

import ActivityView from "./ActivityView.vue"

const sel = (t: string) => `[data-testid="${t}"]`
const view = () => mount(ActivityView, { global: { stubs: { BridgeJournal: JournalStub } } })

describe("ActivityView", () => {
	beforeEach(() => {
		placeholder.value = false
		records.value = []
		__resetShellForTests()
	})

	it("reads every record, foregrounded ones included, and passes the highlight through", () => {
		useShell().openActivity("rec-9")
		const j = view().get(sel(TESTIDS.journal))
		expect(j.attributes("data-source")).toBe("all")
		expect(j.attributes("data-highlighted")).toBe("rec-9")
	})

	it("a first visit gets the two verb tiles; either one changes the section", async () => {
		const w = view()
		expect(w.find(sel(TESTIDS.activityFirstVisit)).exists()).toBe(true)
		await w.get(sel(TESTIDS.activityTileDrip)).trigger("click")
		expect(useShell().section.value).toBe("drip")
		await w.get(sel(TESTIDS.activityTileSend)).trigger("click")
		expect(useShell().section.value).toBe("send")
	})

	it("with records the tiles are gone — the list owns the space", () => {
		records.value = [{ id: "x" }]
		expect(view().find(sel(TESTIDS.activityFirstVisit)).exists()).toBe(false)
	})

	it("a placeholder network shows the notice and instantiates no list", () => {
		placeholder.value = true
		const w = view()
		expect(w.find(sel(TESTIDS.activityUnavailable)).exists()).toBe(true)
		expect(w.find(sel(TESTIDS.journal)).exists()).toBe(false)
	})
})
