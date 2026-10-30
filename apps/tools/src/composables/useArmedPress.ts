import { onScopeDispose, ref, type Ref } from "vue"

/** How long an armed destructive button waits for the press that confirms it. */
export const ARMED_MS = 6000

/**
 * A destructive button's two-step press: the first press arms it, a second within `ARMED_MS` acts. An armed state that
 * never fires disarms, so a later stray click cannot delete what the first press only offered to.
 */
export function useArmedPress(): { armed: Ref<boolean>; press: (act: () => void) => void } {
	const armed = ref(false)
	let timer: ReturnType<typeof setTimeout> | undefined
	const disarm = () => {
		clearTimeout(timer)
		armed.value = false
	}
	onScopeDispose(disarm)
	return {
		armed,
		press(act) {
			if (!armed.value) {
				armed.value = true
				timer = setTimeout(disarm, ARMED_MS)
				return
			}
			disarm()
			act()
		},
	}
}
