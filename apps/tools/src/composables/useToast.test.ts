import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { __resetToastsForTests, useToast } from "./useToast"

describe("useToast", () => {
	beforeEach(() => {
		vi.useFakeTimers()
		__resetToastsForTests()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it("push adds a toast and assigns a numeric id", () => {
		const { toasts, push } = useToast()
		const id = push({ kind: "ok", text: "Dripped 1,000 USDC to public" })
		expect(typeof id).toBe("number")
		expect(toasts.value).toHaveLength(1)
		expect(toasts.value[0]).toMatchObject({ id, kind: "ok", text: "Dripped 1,000 USDC to public" })
	})

	it("an entry carries its lead and TTL, and leaves when the TTL runs out", () => {
		const { toasts, push } = useToast()
		push({ kind: "ok", text: "x" })
		push({ kind: "error", lead: "Could not claim your gas.", text: "Try again.", ttlMs: 2_000 })
		expect(toasts.value.map((t) => t.ttlMs)).toEqual([6_000, 2_000])
		expect(toasts.value[1]).toMatchObject({ lead: "Could not claim your gas.", text: "Try again." })
		vi.advanceTimersByTime(2_000)
		expect(toasts.value.map((t) => t.text)).toEqual(["x"])
	})

	it("strips bidi controls from a toast's lead and text and caps them", () => {
		const { toasts, push } = useToast()
		const hostile = `\u202E${"x".repeat(10_000)}`
		push({ kind: "error", lead: hostile, text: hostile })
		const [t] = toasts.value
		for (const s of [t?.lead ?? "", t?.text ?? ""]) {
			expect(s).not.toContain("\u202E")
			expect(Array.from(s).length).toBeLessThanOrEqual(241)
		}
	})

	it("dismiss removes a toast by id and clears its timer", () => {
		const { toasts, push, dismiss } = useToast()
		const id = push({ kind: "info", text: "x" })
		dismiss(id)
		expect(toasts.value).toHaveLength(0)
	})

	it("auto-dismisses after the default TTL", () => {
		const { toasts, push } = useToast()
		push({ kind: "ok", text: "x" })
		expect(toasts.value).toHaveLength(1)
		vi.advanceTimersByTime(6_000)
		expect(toasts.value).toHaveLength(0)
	})

	it("preserves insertion order across multiple pushes", () => {
		const { toasts, push } = useToast()
		push({ kind: "ok", text: "first" })
		push({ kind: "error", text: "second" })
		push({ kind: "info", text: "third" })
		expect(toasts.value.map((t) => t.text)).toEqual(["first", "second", "third"])
	})

	it("drops the oldest entry when MAX_QUEUE is exceeded", () => {
		const { toasts, push } = useToast()
		for (let i = 0; i < 6; i++) push({ kind: "info", text: `t${i}` })
		expect(toasts.value).toHaveLength(4)
		expect(toasts.value[0].text).toBe("t2")
		expect(toasts.value[3].text).toBe("t5")
	})
})
