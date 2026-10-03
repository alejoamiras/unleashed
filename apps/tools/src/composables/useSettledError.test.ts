import { beforeEach, afterEach, describe, expect, it, vi } from "vitest"
import { computed, nextTick, ref } from "vue"
import { useSettledError } from "./useSettledError"

describe("useSettledError", () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	function make(settleMs = 600) {
		const source = ref("")
		const error = ref<string | null>(null)
		const validation = computed(() => error.value)
		const settledError = useSettledError(source, validation, settleMs)
		return { source, error, ...settledError }
	}

	it("shows nothing before the input is ever touched, even with a live error", () => {
		const s = make()
		s.error.value = "Minimum is 16"
		expect(s.shown.value).toBeNull()
	})

	it("hides the error while typing and shows it after the settle window", async () => {
		const s = make()
		s.source.value = "15"
		s.error.value = "Minimum is 16"
		await nextTick()
		expect(s.shown.value).toBeNull()
		vi.advanceTimersByTime(600)
		expect(s.shown.value).toBe("Minimum is 16")
	})

	it("each keystroke re-arms the window (no mid-typing flash)", async () => {
		const s = make()
		s.source.value = "1"
		s.error.value = "Minimum is 16"
		await nextTick()
		vi.advanceTimersByTime(400)
		s.source.value = "15"
		await nextTick()
		vi.advanceTimersByTime(400)
		expect(s.shown.value).toBeNull()
		vi.advanceTimersByTime(200)
		expect(s.shown.value).toBe("Minimum is 16")
	})

	it("a valid final value settles with no error shown", async () => {
		const s = make()
		s.source.value = "15"
		s.error.value = "Minimum is 16"
		await nextTick()
		s.source.value = "150"
		s.error.value = null
		await nextTick()
		vi.advanceTimersByTime(600)
		expect(s.shown.value).toBeNull()
	})

	it("settleNow shows the error immediately (blur/submit path)", async () => {
		const s = make()
		s.source.value = "15"
		s.error.value = "Minimum is 16"
		await nextTick()
		s.settleNow()
		expect(s.shown.value).toBe("Minimum is 16")
	})

	it("settleNow marks touched even with no prior typing (submit on the default value)", () => {
		const s = make()
		s.error.value = "Minimum is 16"
		s.settleNow()
		expect(s.touched.value).toBe(true)
		expect(s.shown.value).toBe("Minimum is 16")
	})

	it("dispose cancels the pending window (no late flip after unmount)", async () => {
		const s = make()
		s.source.value = "15"
		s.error.value = "Minimum is 16"
		await nextTick()
		s.dispose()
		vi.advanceTimersByTime(600)
		expect(s.shown.value).toBeNull()
	})

	it("the error stays LIVE for submit gates: shown is display-only", async () => {
		const s = make()
		s.source.value = "15"
		s.error.value = "Minimum is 16"
		await nextTick()
		// Mid-window the display hides the error but the validation itself never blinks.
		expect(s.shown.value).toBeNull()
		expect(s.error.value).toBe("Minimum is 16")
	})
})
