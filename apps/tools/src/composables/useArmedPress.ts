import { onScopeDispose, ref, type Ref } from "vue"

/** How long an armed destructive button waits for the press that confirms it. */
export const ARMED_MS = 6000

/**
 * A destructive button's two-step press: the first press arms it, a second within `ARMED_MS` acts. An armed state that
 * never fires disarms, so a later stray click cannot delete what the first press only offered to. The second click of
 * a double-click belongs to the gesture that armed, so it never confirms.
 */
export function useArmedPress(): { armed: Ref<boolean>; press: (act: () => void, e?: MouseEvent) => void } {
	const armed = ref(false)
	let timer: ReturnType<typeof setTimeout> | undefined
	const disarm = () => {
		clearTimeout(timer)
		armed.value = false
	}
	onScopeDispose(disarm)
	return {
		armed,
		press(act, e) {
			if (!armed.value) {
				armed.value = true
				timer = setTimeout(disarm, ARMED_MS)
				return
			}
			if ((e?.detail ?? 0) > 1) return
			disarm()
			act()
		},
	}
}

/** Bound to `keydown` on an armed button: a held key's auto-repeat would otherwise activate it again and confirm. */
export function refuseRepeat(e: KeyboardEvent): void {
	if (e.repeat) e.preventDefault()
}
