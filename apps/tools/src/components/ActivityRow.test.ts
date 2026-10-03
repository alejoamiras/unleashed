import { mount } from "@vue/test-utils"
import { describe, expect, it } from "vitest"
import type { ActivityRowModel } from "@/composables/useActivityFeed"
import { TESTIDS } from "@/lib/testids"
import { rowModel as row } from "@/test/activity-row"
import { BusyPixels, Icon } from "@unleashed/design"
import ActivityRow from "./ActivityRow.vue"

const sel = (t: string) => `[data-testid="${t}"]`

const mountRow = (r: ActivityRowModel, extra: Record<string, unknown> = {}) => mount(ActivityRow, { props: { row: r, ...extra } })

describe("ActivityRow", () => {
	it("is two lines in a list item: amount and symbol as one run, then route · age beside a button", () => {
		const w = mountRow(row())
		expect(w.element.tagName).toBe("LI")
		expect(w.get(".amt").text()).toBe("0.5 WETH")
		expect(w.get(".meta").text()).toBe("ETH → Aztec · 26m ago")
		expect(w.get(sel(TESTIDS.activityRowOpen)).attributes("aria-label")).toBe("Open 0.5 WETH, ETH → Aztec, public + gas, 26m ago")
		expect(w.get(sel(TESTIDS.activityRowAction)).text()).toBe("Claim")
		expect(w.get(sel(TESTIDS.activityRowAction)).classes()).toContain("filled")
	})

	it("running rows show the running word and route · visibility · age; done rows say Arrived with a check", () => {
		const running = mountRow(row({ group: "running", action: null, phase: "Proving", age: "3m ago" }))
		expect(running.find(sel(TESTIDS.activityRowAction)).exists()).toBe(false)
		expect(running.get(".side").text()).toBe("Proving")
		expect(running.get(".meta").text()).toBe("ETH → Aztec · public + gas · 3m ago")
		const done = mountRow(row({ group: "done", action: null, age: "yesterday" }))
		expect(done.get(".side").text()).toBe("Arrived")
		expect(done.get(".side").findComponent(Icon).props("name")).toBe("check")
		expect(done.attributes("data-status")).toBe("done")
	})

	it("a gross gas-only amount carries its qualifier on a line of its own and in the open label", () => {
		const gas = { amount: "2.00", symbol: "FJ", qualifier: "before claim fees", visibility: "public" }
		const done = mountRow(row({ ...gas, group: "done", action: null, age: "3m ago" }))
		expect(done.get(".amt").text()).toBe("2.00 FJ")
		expect(done.get(".qualifier").text()).toBe("before claim fees")
		expect(done.get(sel(TESTIDS.activityRowOpen)).attributes("aria-label")).toBe(
			"Open 2.00 FJ before claim fees, ETH → Aztec, public, 3m ago",
		)
		expect(mountRow(row()).find(".qualifier").exists()).toBe(false)
	})

	it("a row with no action shows its status word; the card on Activity has the decision", () => {
		const lost = mountRow(row({ action: null, status: "lost" }))
		expect(lost.find(sel(TESTIDS.activityRowAction)).exists()).toBe(false)
		expect(lost.get(".side").text()).toBe("Lost signal")
		expect(lost.get(".side").findComponent(Icon).props("name")).toBe("square-alert")
		expect(
			mountRow(row({ action: null }))
				.get(".side")
				.text(),
		).toBe("Needs you")
	})

	it("every action has its label; Retry and a done row's gas recovery stay secondary", () => {
		expect(
			mountRow(row({ action: "finish", direction: "withdraw" }))
				.get(sel(TESTIDS.activityRowAction))
				.text(),
		).toBe("Finish")
		const retry = mountRow(row({ action: "retry" })).get(sel(TESTIDS.activityRowAction))
		expect(retry.text()).toBe("Retry")
		expect(retry.findComponent(Icon).props("name")).toBe("reload")
		expect(retry.classes()).not.toContain("filled")
		const gas = mountRow(row({ group: "done", action: "claim-gas" })).get(sel(TESTIDS.activityRowAction))
		expect(gas.text()).toBe("Claim gas")
		expect(gas.classes()).not.toContain("filled")
	})

	it("emits act with its id and action — never open with it; the row and its amount button open", async () => {
		const w = mountRow(row())
		await w.get(sel(TESTIDS.activityRowAction)).trigger("click")
		expect(w.emitted("act")).toEqual([["rec-1", "claim"]])
		expect(w.emitted("open")).toBeUndefined()
		await w.get(sel(TESTIDS.activityRowOpen)).trigger("click")
		await w.get(sel(TESTIDS.activityRow)).trigger("click")
		expect(w.emitted("open")).toEqual([["rec-1"], ["rec-1"]])
	})

	it("Switch is disabled while another operation runs, with the card's reason; an acting row keeps its label, busy", async () => {
		const sw = mountRow(row({ action: "switch", switchTarget: "0xother" }), { switchLocked: true })
		const btn = sw.get(sel(TESTIDS.activityRowAction))
		expect(btn.attributes("disabled")).toBeDefined()
		expect(btn.attributes("title")).toBe("Finish the current operation to switch.")
		await btn.trigger("click")
		expect(sw.emitted("act")).toBeUndefined()
		const acting = mountRow(row({ group: "done", action: "claim-gas" }), { acting: true }).get(sel(TESTIDS.activityRowAction))
		expect(acting.text()).toBe("Claim gas")
		expect(acting.attributes("aria-busy")).toBe("true")
		expect(acting.findComponent(BusyPixels).exists()).toBe(true)
	})

	it("the foreground row is the current item: this send, no button, its running word", () => {
		const w = mountRow(row({ group: "running", status: "running", action: null, foreground: true, phase: "Crossing" }))
		expect(w.attributes("aria-current")).toBe("true")
		expect(w.get(".meta").text()).toBe("ETH → Aztec · this send")
		expect(w.get(".side").text()).toBe("Crossing")
		expect(w.find(sel(TESTIDS.activityRowAction)).exists()).toBe(false)
	})
})
