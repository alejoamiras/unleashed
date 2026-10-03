import { ref } from "vue"

/**
 * ONE app-wide 1s heartbeat for live timers/ages. Per-component intervals multiplied (N cards =
 * N timers ticking in background tabs); every consumer now shares this ref. Started lazily,
 * never torn down - a single interval is cheaper than refcounting it.
 */
const now = ref(Date.now())
let started = false

export function useNow() {
	if (!started && typeof window !== "undefined") {
		started = true
		now.value = Date.now() // the ref may have sat frozen since module load - refresh before first use.
		setInterval(() => {
			now.value = Date.now()
		}, 1000)
	}
	return now
}
