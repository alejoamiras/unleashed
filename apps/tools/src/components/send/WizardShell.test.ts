import { mount } from "@vue/test-utils"
import { afterEach, describe, expect, it, vi } from "vitest"
import { nextTick } from "vue"
import type { Direction } from "@/lib/send-model"
import { TESTIDS } from "@/lib/testids"
import WizardShell from "./WizardShell.vue"

const sel = (t: string) => `[data-testid="${t}"]`

// The step components are the other half of the wizard; the shell only has to place them.
const stubs = {
	StepStrip: {
		name: "StepStrip",
		props: ["steps", "active", "completed", "orientation"],
		template: '<div data-strip><button type="button" data-strip-tab>Amount</button></div>',
	},
}

function shell(
	props: Partial<{ direction: Direction; step: 0 | 1 | 2; completed: number; canSwitchDirection: boolean }> = {},
	token = "<p>TOKEN SLOT</p>",
) {
	return mount(WizardShell, {
		props: { direction: "l1-to-l2", step: 0, completed: 0, canSwitchDirection: true, ...props },
		slots: { token, amount: "<p>AMOUNT SLOT</p>", review: "<p>REVIEW SLOT</p>" },
		global: { stubs },
		attachTo: document.body,
	})
}

describe("WizardShell", () => {
	it("renders both directions as a tablist", () => {
		const w = shell()
		expect(w.find(sel(TESTIDS.sendDirection)).attributes("role")).toBe("tablist")
		expect(w.find(sel(TESTIDS.sendDirectionDeposit)).text()).toBe("Ethereum → Aztec")
		expect(w.find(sel(TESTIDS.sendDirectionExit)).text()).toBe("Aztec → Ethereum")
	})

	it("is ONE Tab stop: only the selected direction is tabbable", () => {
		const w = shell({ direction: "l2-to-l1" })
		expect(w.find(sel(TESTIDS.sendDirectionExit)).attributes("tabindex")).toBe("0")
		expect(w.find(sel(TESTIDS.sendDirectionDeposit)).attributes("tabindex")).toBe("-1")
	})

	it("marks the selected direction for assistive tech", () => {
		const w = shell()
		expect(w.find(sel(TESTIDS.sendDirectionDeposit)).attributes("aria-selected")).toBe("true")
		expect(w.find(sel(TESTIDS.sendDirectionExit)).attributes("aria-selected")).toBe("false")
	})

	it("clicking the other direction emits it", async () => {
		const w = shell()
		await w.find(sel(TESTIDS.sendDirectionExit)).trigger("click")
		expect(w.emitted("update:direction")).toEqual([["l2-to-l1"]])
	})

	it("clicking the direction already selected emits nothing", async () => {
		const w = shell()
		await w.find(sel(TESTIDS.sendDirectionDeposit)).trigger("click")
		expect(w.emitted("update:direction")).toBeUndefined()
	})

	it("→ and ← wrap around the segment and move focus with the selection", async () => {
		const w = shell()
		await w.find(sel(TESTIDS.sendDirectionDeposit)).trigger("keydown.right")
		expect(w.emitted("update:direction")).toEqual([["l2-to-l1"]])
		expect(document.activeElement).toBe(w.find(sel(TESTIDS.sendDirectionExit)).element)
		await w.find(sel(TESTIDS.sendDirectionDeposit)).trigger("keydown.left")
		expect(w.emitted("update:direction")).toEqual([["l2-to-l1"], ["l2-to-l1"]])
	})

	it("canSwitchDirection=false disables the segment and refuses click + arrow", async () => {
		const w = shell({ canSwitchDirection: false })
		expect(w.find(sel(TESTIDS.sendDirection)).attributes("data-locked")).toBe("true")
		expect(w.find(sel(TESTIDS.sendDirectionExit)).attributes("disabled")).toBeDefined()
		await w.find(sel(TESTIDS.sendDirectionExit)).trigger("click")
		await w.find(sel(TESTIDS.sendDirectionDeposit)).trigger("keydown.right")
		expect(w.emitted("update:direction")).toBeUndefined()
	})

	it("hands the strip the three steps plus the active and completed indices, as a vertical rail with hints", () => {
		const strip = shell({ step: 1, completed: 1 }).findComponent({ name: "StepStrip" })
		expect(strip.props("steps").map((s: { label: string }) => s.label)).toEqual(["Token", "Amount", "Review"])
		expect(strip.props("steps").every((s: { hint?: string }) => !!s.hint)).toBe(true)
		expect(strip.props("orientation")).toBe("vertical")
		expect(strip.props("active")).toBe(1)
		expect(strip.props("completed")).toBe(1)
	})

	describe("at phone width", () => {
		afterEach(() => vi.unstubAllGlobals())

		it("lays the steps out as a horizontal strip", () => {
			vi.stubGlobal("matchMedia", (query: string) => ({
				matches: query === "(max-width: 760px)",
				media: query,
				addEventListener() {},
				removeEventListener() {},
			}))
			expect(shell({ step: 1, completed: 1 }).findComponent({ name: "StepStrip" }).props("orientation")).toBe("horizontal")
		})
	})

	it("the card head counts the step beside the direction tabs; the live caption is off-screen but present", () => {
		const w = shell({ step: 2, completed: 2 })
		expect(w.get(".position").text()).toBe("Step 3 of 3")
		expect(w.get(".position").attributes("aria-hidden")).toBe("true")
		expect(w.get(sel(TESTIDS.sendStepAnnounce)).classes()).toContain("sr-only")
	})

	it("forwards the strip's select as goto", () => {
		const w = shell({ step: 2, completed: 2 })
		w.findComponent({ name: "StepStrip" }).vm.$emit("select", 0)
		expect(w.emitted("goto")).toEqual([[0]])
	})

	it("renders exactly the active step's slot", () => {
		expect(shell({ step: 0 }).text()).toContain("TOKEN SLOT")
		expect(shell({ step: 1 }).text()).toContain("AMOUNT SLOT")
		const review = shell({ step: 2 })
		expect(review.text()).toContain("REVIEW SLOT")
		expect(review.text()).not.toContain("TOKEN SLOT")
	})

	it("moves focus to the new step's hidden heading instead of dropping it on the body", async () => {
		const w = shell()
		document.body.focus()
		await w.setProps({ step: 1 })
		await nextTick()
		const heading = w.get(sel(TESTIDS.sendStepHeading))
		expect(document.activeElement).toBe(heading.element)
		expect(heading.text()).toBe("Amount")
		expect(heading.classes()).toContain("sr-only")
		expect(w.get(sel(TESTIDS.sendStepPanel)).attributes("tabindex")).toBeUndefined()
	})

	it("advancing from a control in the panel hands focus to the new step's heading", async () => {
		const w = shell({}, '<button type="button" data-next>Next</button>')
		;(w.get("[data-next]").element as HTMLElement).focus()
		await w.setProps({ step: 1 })
		await nextTick()
		expect(document.activeElement).toBe(w.get(sel(TESTIDS.sendStepHeading)).element)
	})

	it("an arrow key along the step rail keeps focus on the rail's tab", async () => {
		const w = shell()
		const tab = w.get("[data-strip-tab]").element as HTMLElement
		tab.focus()
		await w.setProps({ step: 1 })
		await nextTick()
		expect(document.activeElement).toBe(tab)
	})

	it("leaves focus alone on arrival — only a step CHANGE takes it", () => {
		const w = shell({ step: 1 })
		expect(document.activeElement).not.toBe(w.find(sel(TESTIDS.sendStepHeading)).element)
	})

	it("announces the step politely, by position and name", async () => {
		const w = shell()
		const live = w.find(sel(TESTIDS.sendStepAnnounce))
		expect(live.attributes("aria-live")).toBe("polite")
		expect(live.text()).toBe("Step 1 of 3, Token: what are you sending?")
		await w.setProps({ step: 2 })
		expect(w.find(sel(TESTIDS.sendStepAnnounce)).text()).toBe("Step 3 of 3, Review: check it, then sign.")
	})

	it("never emits a positive tabindex anywhere in the segment", () => {
		const values = shell()
			.findAll("[tabindex]")
			.map((n) => Number(n.attributes("tabindex")))
		expect(values.every((v) => v <= 0)).toBe(true)
	})
})
