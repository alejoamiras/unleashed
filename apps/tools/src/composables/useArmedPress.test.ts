import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { effectScope } from "vue"
import { ARMED_MS, refuseRepeat, useArmedPress } from "./useArmedPress"

describe("useArmedPress", () => {
	beforeEach(() => vi.useFakeTimers())
	afterEach(() => vi.useRealTimers())

	it("a second press inside the window acts; a lone press disarms and the next press only arms again", () => {
		const act = vi.fn()
		const scope = effectScope()
		const { armed, press } = scope.run(useArmedPress) as ReturnType<typeof useArmedPress>

		press(act)
		vi.advanceTimersByTime(ARMED_MS - 1)
		expect(armed.value).toBe(true)
		vi.advanceTimersByTime(1)
		expect(armed.value).toBe(false)
		press(act)
		expect(act).not.toHaveBeenCalled()

		vi.advanceTimersByTime(ARMED_MS - 1)
		press(act)
		expect(act).toHaveBeenCalledTimes(1)
		expect(armed.value).toBe(false)
		scope.stop()
	})

	it("a double-click only arms; a held key's repeats are refused, a fresh key press is not", () => {
		const act = vi.fn()
		const scope = effectScope()
		const { armed, press } = scope.run(useArmedPress) as ReturnType<typeof useArmedPress>
		press(act, new MouseEvent("click", { detail: 1 }))
		press(act, new MouseEvent("click", { detail: 2 }))
		expect(act).not.toHaveBeenCalled()
		expect(armed.value).toBe(true)
		press(act, new MouseEvent("click", { detail: 1 }))
		expect(act).toHaveBeenCalledTimes(1)
		scope.stop()

		const key = (repeat: boolean) => new KeyboardEvent("keydown", { key: "Enter", repeat, cancelable: true })
		const [held, fresh] = [key(true), key(false)]
		refuseRepeat(held)
		refuseRepeat(fresh)
		expect([held.defaultPrevented, fresh.defaultPrevented]).toEqual([true, false])
	})
})
