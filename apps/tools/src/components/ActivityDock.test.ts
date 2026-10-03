import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { computed, nextTick, ref } from "vue"
import type { ActivityFeed, ActivityRowModel } from "@/composables/useActivityFeed"
import { __resetDockStateForTests, DOCK_KEY, DOCK_SEEN_KEY, useDockState } from "@/composables/useDockState"
import { __resetShellForTests, useShell } from "@/composables/useShell"
import { groupRecords, needsYouCount } from "@/lib/activity"
import { TESTIDS } from "@/lib/testids"
import { rowModel } from "@/test/activity-row"

const runDepositClaim = vi.fn(async (_id: string) => {})
const runWithdrawConsume = vi.fn(async (_id: string) => {})
vi.mock("@/composables/useBridgeJournal", () => ({ useBridgeJournal: () => ({ runDepositClaim, runWithdrawConsume }) }))
const opsBusy = ref(false)
vi.mock("@/composables/useOpsInFlight", () => ({ useOpsInFlight: () => ({ busy: opsBusy }) }))
const switchActiveAccount = vi.fn((_address: string) => true)
vi.mock("@/composables/useWalletConnection", () => ({ switchActiveAccount: (a: string) => switchActiveAccount(a) }))
let releaseGas = (): void => {}
let failGas = (_e: unknown): void => {}
const claimFuelStandalone = vi.fn(
	(_id: string) =>
		new Promise<void>((resolve, reject) => {
			releaseGas = resolve
			failGas = reject
		}),
)
vi.mock("@/composables/fuel-recovery", () => ({ claimFuelStandalone: (id: string) => claimFuelStandalone(id) }))
const push = vi.fn()
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ push }) }))

import ActivityDock from "./ActivityDock.vue"

const sel = (t: string) => `[data-testid="${t}"]`

/** A feed the test drives by hand: the same derived shape `useActivityFeed` produces. */
const rows = ref<ActivityRowModel[]>([])
const feed: ActivityFeed = {
	rows: computed(() => rows.value),
	grouped: computed(() => groupRecords(rows.value)),
	count: computed(() => needsYouCount(rows.value)),
	autoOpenIds: computed(() => rows.value.filter((r) => r.counts).map((r) => r.id)),
	liveIds: computed(() => new Set(rows.value.map((r) => r.id))),
}

enableAutoUnmount(afterEach)
const dock = () => mount(ActivityDock, { props: { feed }, attachTo: document.body })

/** jsdom has no `matchMedia`; a stub answers only the dock's narrow query and can be resized. */
function viewport(narrow: boolean): { resize(next: boolean): void } {
	const QUERY = "(max-width: 1100px)"
	let now = narrow
	const listeners = new Set<(e: { matches: boolean }) => void>()
	vi.stubGlobal("matchMedia", (query: string) => ({
		get matches() {
			return now && query === QUERY
		},
		media: query,
		addEventListener(_: string, fn: (e: { matches: boolean }) => void) {
			if (query === QUERY) listeners.add(fn)
		},
		removeEventListener(_: string, fn: (e: { matches: boolean }) => void) {
			listeners.delete(fn)
		},
	}))
	return {
		resize(next) {
			now = next
			for (const fn of listeners) fn({ matches: next })
		},
	}
}

const key = (k: string, shiftKey = false) => {
	const e = new KeyboardEvent("keydown", { key: k, shiftKey, cancelable: true })
	document.dispatchEvent(e)
	return e
}

describe("ActivityDock", () => {
	beforeEach(() => {
		localStorage.clear()
		rows.value = []
		opsBusy.value = false
		__resetDockStateForTests()
		__resetShellForTests()
		vi.clearAllMocks()
		vi.unstubAllGlobals()
		document.body.innerHTML = ""
	})

	it("is hidden by default: the strip, no badge while nothing needs you", () => {
		const w = dock()
		expect(w.find(sel(TESTIDS.dock)).exists()).toBe(false)
		expect(w.find(sel(TESTIDS.dockStrip)).exists()).toBe(true)
		expect(w.find(sel(TESTIDS.dockBadge)).exists()).toBe(false)
	})

	it("running and other-account rows never badge or open the dock; a lost row does both", async () => {
		rows.value = [
			rowModel({ id: "a", group: "running", action: null }),
			rowModel({ id: "o", group: "other-account", action: "switch", counts: false }),
		]
		const w = dock()
		expect(w.find(sel(TESTIDS.dockBadge)).exists()).toBe(false)
		expect(w.find(sel(TESTIDS.dock)).exists()).toBe(false)
		rows.value = [...rows.value, rowModel({ id: "b", action: null, status: "lost" })]
		await nextTick()
		expect(feed.count.value).toBe(1)
		expect(w.find(sel(TESTIDS.dock)).exists()).toBe(true)
	})

	it("show persists the choice; hide persists it, marks the needs-you rows seen, and moves focus to the strip", async () => {
		// Already seen, so it badges without opening the dock by itself.
		localStorage.setItem(DOCK_SEEN_KEY, JSON.stringify(["a"]))
		rows.value = [rowModel({ id: "a", action: null, status: "lost" })]
		const w = dock()
		await w.get(sel(TESTIDS.dockOpen)).trigger("click")
		expect(w.find(sel(TESTIDS.dock)).exists()).toBe(true)
		expect(localStorage.getItem(DOCK_KEY)).toBe("open")
		await w.get(sel(TESTIDS.dockHide)).trigger("click")
		await nextTick()
		expect(w.find(sel(TESTIDS.dock)).exists()).toBe(false)
		expect(localStorage.getItem(DOCK_KEY)).toBe("hidden")
		expect(JSON.parse(localStorage.getItem(DOCK_SEEN_KEY) ?? "[]")).toEqual(["a"])
		expect(document.activeElement).toBe(w.get(sel(TESTIDS.dockOpen)).element)
	})

	it("opens itself once for a record that starts needing you — never for another account's, never twice, never touching the choice", async () => {
		rows.value = [rowModel({ id: "theirs", group: "other-account", action: "switch", counts: false })]
		const w = dock()
		expect(w.find(sel(TESTIDS.dock)).exists()).toBe(false)
		rows.value = [...rows.value, rowModel({ id: "claim" })]
		await nextTick()
		expect(w.find(sel(TESTIDS.dock)).exists()).toBe(true)
		expect(localStorage.getItem(DOCK_KEY)).toBeNull()
		await w.get(sel(TESTIDS.dockHide)).trigger("click")
		// The same record re-entering needs-you (a RETRY, a reload) does not reopen it.
		rows.value = [rows.value[0] as ActivityRowModel]
		await nextTick()
		rows.value = [...rows.value, rowModel({ id: "claim", action: "retry" })]
		await nextTick()
		expect(w.find(sel(TESTIDS.dock)).exists()).toBe(false)
		expect(w.get(sel(TESTIDS.dockBadge)).text()).toBe("1")
	})

	it("groups rows under Needs you / Running / Done with counts, and an empty dock shows the empty channel", async () => {
		useDockState().show()
		const w = dock()
		expect(w.text()).toContain("Nothing on this channel yet")
		expect(w.get(sel(TESTIDS.dock)).attributes("aria-label")).toBe("Activity")
		rows.value = [
			rowModel({ id: "n", createdAt: 3 }),
			rowModel({ id: "r", group: "running", action: null, phase: "Crossing", createdAt: 2 }),
			rowModel({ id: "d", group: "done", action: null, createdAt: 1 }),
		]
		await nextTick()
		const groups = w.findAll(sel(TESTIDS.dockGroup))
		expect(groups.map((g) => g.attributes("data-group"))).toEqual(["needs-you", "running", "done"])
		expect(groups.map((g) => g.get("h3").text())).toEqual(["Needs you · 1", "Running · 1", "Done · 1"])
		expect(groups.every((g) => g.find("ul[role='list'] > li").exists())).toBe(true)
		expect(w.text()).not.toContain("Nothing on this channel yet")
		expect(w.text()).toContain("3 records")
	})

	it("a lost row sits first in Needs you; another account's rows trail in their own group", async () => {
		useDockState().show()
		rows.value = [
			rowModel({ id: "claim", createdAt: 2 }),
			rowModel({ id: "lost", status: "lost", action: null, createdAt: 1 }),
			rowModel({ id: "theirs", group: "other-account", action: "switch", switchTarget: "0xo", createdAt: 3 }),
			rowModel({ id: "done", group: "done", action: null, createdAt: 4 }),
		]
		const w = dock()
		const groups = w.findAll(sel(TESTIDS.dockGroup))
		expect(groups.map((g) => g.attributes("data-group"))).toEqual(["needs-you", "done", "other-account"])
		expect(groups[0]?.findAll(sel(TESTIDS.activityRow)).map((r) => r.attributes("data-record-id"))).toEqual(["lost", "claim"])
		expect(groups[2]?.get("h3").text()).toBe("Other account · 1")
	})

	it("dispatches each action to the engine entry the card uses, by the row's direction", async () => {
		useDockState().show()
		rows.value = [
			rowModel({ id: "dep", action: "claim" }),
			rowModel({ id: "wd", direction: "withdraw", action: "finish" }),
			rowModel({ id: "rt", direction: "withdraw", action: "retry" }),
			rowModel({ id: "sw", action: "switch", switchTarget: "0xcanon" }),
		]
		const w = dock()
		const buttons = w.findAll(sel(TESTIDS.activityRowAction))
		for (const b of buttons) await b.trigger("click")
		expect(runDepositClaim).toHaveBeenCalledWith("dep")
		expect(runWithdrawConsume.mock.calls.map(([id]) => id)).toEqual(["wd", "rt"])
		expect(switchActiveAccount).toHaveBeenCalledWith("0xcanon")
	})

	it("SWITCH is refused while an operation runs; CLAIM GAS cannot double-fire and reports a failure as a toast", async () => {
		useDockState().show()
		opsBusy.value = true
		rows.value = [
			rowModel({ id: "sw", action: "switch", switchTarget: "0xcanon" }),
			rowModel({ id: "gas", group: "done", action: "claim-gas" }),
		]
		const w = dock()
		const [sw, gas] = w.findAll(sel(TESTIDS.activityRowAction))
		expect(sw?.attributes("disabled")).toBeDefined()
		await gas?.trigger("click")
		await gas?.trigger("click")
		expect(claimFuelStandalone).toHaveBeenCalledTimes(1)
		expect(gas?.text()).toBe("Claim gas")
		expect(gas?.attributes("aria-busy")).toBe("true")
		failGas(new Error("Fee juice already claimed"))
		await flushPromises()
		expect(push).toHaveBeenCalledWith({ kind: "error", lead: "Could not claim your gas.", text: "Fee juice already claimed" })
		expect(gas?.attributes("aria-busy")).toBeUndefined()
		await gas?.trigger("click")
		expect(claimFuelStandalone).toHaveBeenCalledTimes(2)
		releaseGas()
	})

	it("a row body opens Activity on that record; the foot opens the page", async () => {
		useDockState().show()
		rows.value = [rowModel({ id: "rec-9", group: "running", action: null })]
		const w = dock()
		await w.get(sel(TESTIDS.activityRowOpen)).trigger("click")
		expect(useShell().section.value).toBe("activity")
		expect(useShell().highlightedId.value).toBe("rec-9")
		__resetShellForTests()
		await w.get(sel(TESTIDS.dockAll)).trigger("click")
		expect(useShell().section.value).toBe("activity")
		expect(useShell().highlightedId.value).toBeNull()
	})

	it("the running send's row goes back to its stepper, not to Activity", async () => {
		useDockState().show()
		useShell().goTo("drip")
		rows.value = [rowModel({ id: "fg", group: "running", status: "running", action: null, foreground: true })]
		const w = dock()
		await w.get(sel(TESTIDS.activityRow)).trigger("click")
		expect(useShell().section.value).toBe("send")
		expect(useShell().highlightedId.value).toBeNull()
	})

	it("under 1100px the running send's row closes the overlay on its way to the stepper", async () => {
		viewport(true)
		useShell().goTo("drip")
		rows.value = [rowModel({ id: "fg", group: "running", status: "running", action: null, foreground: true })]
		const w = dock()
		await w.get(sel(TESTIDS.dockOpen)).trigger("click")
		await w.get(sel(TESTIDS.activityRow)).trigger("click")
		await nextTick()
		expect(useShell().section.value).toBe("send")
		expect(w.find(sel(TESTIDS.dock)).exists()).toBe(false)
		expect(w.find(sel(TESTIDS.dockScrim)).exists()).toBe(false)
		expect(localStorage.getItem(DOCK_KEY)).toBeNull()
		expect(document.activeElement).toBe(w.get(sel(TESTIDS.dockOpen)).element)
	})

	it("under 1100px a tap opens a dialog over the static scrim, the strip stays, and Escape closes it back to the strip", async () => {
		viewport(true)
		localStorage.setItem(DOCK_SEEN_KEY, JSON.stringify(["a"]))
		rows.value = [rowModel({ id: "a", action: null, status: "lost" })]
		const w = dock()
		expect(w.get(sel(TESTIDS.dockBadge)).text()).toBe("1")
		await w.get(sel(TESTIDS.dockOpen)).trigger("click")
		await nextTick()
		const panel = w.get(sel(TESTIDS.dock))
		expect(panel.attributes("role")).toBe("dialog")
		expect(panel.attributes("aria-modal")).toBe("true")
		expect(w.find(sel(TESTIDS.dockScrim)).classes()).toContain("ul-scrim")
		expect(w.find(sel(TESTIDS.dockStrip)).exists()).toBe(true)
		// Open, the buttons are the signal: the strip drops its badge and its chevron now hides.
		expect(w.find(sel(TESTIDS.dockBadge)).exists()).toBe(false)
		expect(w.get(sel(TESTIDS.dockOpen)).attributes("aria-label")).toBe("Hide activity")
		// An explicit open takes focus in.
		expect(document.activeElement).toBe(w.get(sel(TESTIDS.dockHide)).element)
		key("Escape")
		await nextTick()
		expect(w.find(sel(TESTIDS.dock)).exists()).toBe(false)
		expect(w.find(sel(TESTIDS.dockScrim)).exists()).toBe(false)
		expect(document.activeElement).toBe(w.get(sel(TESTIDS.dockOpen)).element)
	})

	it("under 1100px a persisted open is ignored, nothing opens by itself, and a scrim click hides without writing the choice", async () => {
		viewport(true)
		useDockState().show()
		localStorage.removeItem(DOCK_KEY)
		rows.value = [rowModel({ id: "claim" })]
		const w = dock()
		await nextTick()
		expect(w.find(sel(TESTIDS.dock)).exists()).toBe(false)
		expect(w.get(sel(TESTIDS.dockBadge)).text()).toBe("1")
		// Suppressed, not consumed: the record is not marked seen while narrow.
		expect(localStorage.getItem(DOCK_SEEN_KEY)).toBeNull()
		await w.get(sel(TESTIDS.dockOpen)).trigger("click")
		expect(w.find(sel(TESTIDS.dock)).exists()).toBe(true)
		await w.get(sel(TESTIDS.dockScrim)).trigger("click")
		await nextTick()
		expect(w.find(sel(TESTIDS.dock)).exists()).toBe(false)
		expect(localStorage.getItem(DOCK_KEY)).toBeNull()
		expect(JSON.parse(localStorage.getItem(DOCK_SEEN_KEY) ?? "[]")).toEqual(["claim"])
	})

	it("Tab wraps inside the overlay; a desktop↔tablet resize turns the trap on only while the overlay shows and leaks no listener", async () => {
		const add = vi.spyOn(document, "addEventListener")
		const remove = vi.spyOn(document, "removeEventListener")
		const keydowns = (spy: typeof add) => spy.mock.calls.filter(([type]) => type === "keydown").length
		const screen = viewport(false)
		useDockState().show()
		rows.value = [rowModel({ id: "a", group: "running", action: null })]
		const w = dock()
		// Wide: an ordinary panel in the grid, no strip, no trap.
		expect(w.get(sel(TESTIDS.dock)).attributes("role")).toBeUndefined()
		expect(w.find(sel(TESTIDS.dockStrip)).exists()).toBe(false)
		expect(key("Tab").defaultPrevented).toBe(false)

		screen.resize(true)
		await nextTick()
		expect(w.find(sel(TESTIDS.dock)).exists()).toBe(false)
		expect(key("Tab").defaultPrevented).toBe(false)
		await w.get(sel(TESTIDS.dockOpen)).trigger("click")
		await nextTick()
		const last = w.get(sel(TESTIDS.dockAll)).element as HTMLElement
		last.focus()
		expect(key("Tab").defaultPrevented).toBe(true)
		expect(document.activeElement).toBe(w.get(sel(TESTIDS.dockHide)).element)
		key("Tab", true)
		expect(document.activeElement).toBe(last)

		screen.resize(false)
		await nextTick()
		expect(w.get(sel(TESTIDS.dock)).attributes("role")).toBeUndefined()
		expect(key("Tab").defaultPrevented).toBe(false)
		w.unmount()
		expect(keydowns(add)).toBe(1)
		expect(keydowns(remove)).toBe(1)
	})

	it("narrowing to a tablet hands focus from the dropped wide panel to the strip, and leaves focus elsewhere alone", async () => {
		const screen = viewport(false)
		useDockState().show()
		rows.value = [rowModel({ id: "a", group: "running", action: null })]
		const w = dock()
		;(w.get(sel(TESTIDS.dockAll)).element as HTMLElement).focus()
		screen.resize(true)
		await flushPromises()
		expect(w.find(sel(TESTIDS.dock)).exists()).toBe(false)
		expect(document.activeElement).toBe(w.get(sel(TESTIDS.dockOpen)).element)

		screen.resize(false)
		await flushPromises()
		const outside = document.createElement("button")
		document.body.appendChild(outside)
		outside.focus()
		screen.resize(true)
		await flushPromises()
		expect(w.find(sel(TESTIDS.dock)).exists()).toBe(false)
		expect(document.activeElement).toBe(outside)
	})

	it("under 1100px a wallet dialog owns the keyboard whether or not it took focus", async () => {
		viewport(true)
		rows.value = [rowModel({ id: "a", group: "running", action: null })]
		const w = dock()
		await w.get(sel(TESTIDS.dockOpen)).trigger("click")
		await nextTick()
		const modal = document.createElement("div")
		modal.setAttribute("aria-modal", "true")
		modal.innerHTML = "<button>pick</button>"
		document.body.appendChild(modal)
		expect(key("Escape").defaultPrevented).toBe(false)
		modal.querySelector("button")?.focus()
		expect(key("Tab").defaultPrevented).toBe(false)
		await nextTick()
		expect(w.find(sel(TESTIDS.dock)).exists()).toBe(true)
		modal.remove()
		key("Escape")
		await nextTick()
		expect(w.find(sel(TESTIDS.dock)).exists()).toBe(false)
	})
})
