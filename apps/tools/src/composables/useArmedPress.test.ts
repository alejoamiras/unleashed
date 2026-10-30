import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { effectScope } from "vue"
import { ARMED_MS, useArmedPress } from "./useArmedPress"

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
})
