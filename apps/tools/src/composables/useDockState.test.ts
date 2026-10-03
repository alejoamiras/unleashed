import { beforeEach, describe, expect, it } from "vitest"
import { __resetDockStateForTests, DOCK_KEY, DOCK_SEEN_KEY, readDockPreference, readSeen, useDockState } from "./useDockState"

const live = new Set(["a", "b", "c"])

describe("useDockState", () => {
	beforeEach(() => {
		localStorage.clear()
		__resetDockStateForTests()
	})

	it("is hidden until the user says otherwise; junk in storage reads as hidden", () => {
		expect(useDockState().open.value).toBe(false)
		localStorage.setItem(DOCK_KEY, "sideways")
		expect(readDockPreference()).toBe("hidden")
		localStorage.setItem(DOCK_KEY, "open")
		__resetDockStateForTests()
		expect(useDockState().open.value).toBe(true)
	})

	it("show and hide persist the choice; hide remembers the records it was hidden on", () => {
		const dock = useDockState()
		dock.show()
		expect(localStorage.getItem(DOCK_KEY)).toBe("open")
		dock.hide(["a", "b"], live)
		expect(dock.open.value).toBe(false)
		expect(localStorage.getItem(DOCK_KEY)).toBe("hidden")
		expect([...readSeen()].sort()).toEqual(["a", "b"])
	})

	it("markSeen records the ids and touches neither the open flag nor the choice", () => {
		const dock = useDockState()
		dock.show()
		dock.markSeen(["a", "c"], live)
		expect(dock.open.value).toBe(true)
		expect(localStorage.getItem(DOCK_KEY)).toBe("open")
		expect([...readSeen()].sort()).toEqual(["a", "c"])
	})

	it("opens itself once per record and never writes the choice while doing so", () => {
		const dock = useDockState()
		dock.autoOpenFor(["a"], live)
		expect(dock.open.value).toBe(true)
		expect(localStorage.getItem(DOCK_KEY)).toBeNull()
		dock.hide(["a"], live)
		dock.autoOpenFor(["a"], live)
		expect(dock.open.value).toBe(false)
		// A new record opens it again; the old one stays seen.
		dock.autoOpenFor(["a", "b"], live)
		expect(dock.open.value).toBe(true)
		expect([...readSeen()].sort()).toEqual(["a", "b"])
	})

	it("re-reads the seen set on every call, so another tab's hide counts here", () => {
		const dock = useDockState()
		localStorage.setItem(DOCK_SEEN_KEY, JSON.stringify(["a"]))
		dock.autoOpenFor(["a"], live)
		expect(dock.open.value).toBe(false)
	})

	it("prunes the seen set to records that still exist, and ignores malformed storage", () => {
		const dock = useDockState()
		localStorage.setItem(DOCK_SEEN_KEY, JSON.stringify(["gone", 7, null, "a"]))
		expect([...readSeen()]).toEqual(["gone", "a"])
		dock.hide(["b"], live)
		expect([...readSeen()].sort()).toEqual(["a", "b"])
		localStorage.setItem(DOCK_SEEN_KEY, "{not json")
		expect(readSeen().size).toBe(0)
	})

	it("keeps an id the stored journal holds even when this tab's record list has not caught up", () => {
		const dock = useDockState()
		localStorage.setItem("unleashed-bridge:journal:v1", JSON.stringify({ schema: 1, records: [{ id: "from-other-tab" }] }))
		localStorage.setItem(DOCK_SEEN_KEY, JSON.stringify(["from-other-tab", "gone"]))
		dock.hide(["a"], live)
		expect([...readSeen()].sort()).toEqual(["a", "from-other-tab"])
	})
})
