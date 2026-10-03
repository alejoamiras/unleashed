import { computed, type ComputedRef, type Ref, ref, watch } from "vue"

/**
 * Debounced display of a live validation error: the error stays hidden while
 * the user is still typing and appears once the input settles (or immediately
 * on blur/submit via `settleNow`). The underlying validation stays live —
 * submit paths keep reading the raw error; only the DISPLAY is debounced, so
 * typing "15" en route to "150" never flashes a minimum-amount error.
 *
 * Repo convention: no `onUnmounted` here — the parent calls `dispose()` in its
 * own `onBeforeUnmount`.
 */
export function useSettledError(
	source: Ref<string>,
	error: ComputedRef<string | null> | Ref<string | null>,
	settleMs = 600,
): {
	shown: ComputedRef<string | null>
	touched: Ref<boolean>
	settleNow: () => void
	dispose: () => void
} {
	const touched = ref(false)
	const settled = ref(true)
	let timer: ReturnType<typeof setTimeout> | undefined

	watch(source, () => {
		touched.value = true
		settled.value = false
		clearTimeout(timer)
		timer = setTimeout(() => {
			settled.value = true
		}, settleMs)
	})

	const settleNow = () => {
		touched.value = true
		clearTimeout(timer)
		settled.value = true
	}

	const shown = computed(() => (touched.value && settled.value ? error.value : null))

	return { shown, touched, settleNow, dispose: () => clearTimeout(timer) }
}
