import { nextTick, onScopeDispose, type Ref, watch } from "vue"

export interface FocusTrapOptions {
	/** True adds the document keydown listener and queues the initial focus; false and scope disposal
	 *  remove the listener and restore focus to where it was, if that element is still in the page. */
	enabled: Ref<boolean>
	onEscape: () => void
	/** True while another `[aria-modal=true]` owns the keyboard: Escape and Tab are left alone. */
	shouldYield?: () => boolean
}

const CANDIDATES = "button, a[href], input, select, textarea, [tabindex]"

/** Reachable by Tab: enabled, in tab order, connected, and not hidden by itself or an ancestor. */
export function isTabbable(el: HTMLElement): boolean {
	if (!el.isConnected || el.tabIndex < 0 || el.matches(":disabled")) return false
	if (el.closest("[hidden], [inert]")) return false
	if (getComputedStyle(el).visibility === "hidden") return false
	for (let n: HTMLElement | null = el; n; n = n.parentElement) {
		if (getComputedStyle(n).display === "none") return false
	}
	return true
}

export function tabbablesIn(root: HTMLElement): HTMLElement[] {
	return [...root.querySelectorAll<HTMLElement>(CANDIDATES)].filter(isTabbable)
}

/** Tab and Shift+Tab cycle through the panel's tabbables from wherever focus is. Only one trap may be
 *  active at a time, unless the others yield: each one answers every Tab on the document. */
function cycle(root: HTMLElement, backwards: boolean): void {
	const items = tabbablesIn(root)
	if (items.length === 0) return
	const at = items.indexOf(document.activeElement as HTMLElement)
	const last = items.length - 1
	const next = backwards ? (at <= 0 ? last : at - 1) : at === -1 || at === last ? 0 : at + 1
	items[next].focus()
}

/**
 * Keyboard containment for a modal panel. Initial focus lands on the panel's `[data-autofocus]`
 * descendant, else on the panel (give it `tabindex="-1"`). It is queued for `nextTick`, so a dialog
 * opening in the same flush as another one closes wins over that one's focus restore, and it is
 * dropped if the trap was disabled or disposed, or the panel left the page, in the meantime.
 */
export function useFocusTrap(panel: Ref<HTMLElement | null>, opts: FocusTrapOptions): void {
	let active = false
	let returnTo: HTMLElement | null = null

	function onKeydown(e: KeyboardEvent): void {
		const root = panel.value
		if (!root || opts.shouldYield?.()) return
		if (e.key === "Escape") {
			e.preventDefault()
			opts.onEscape()
		} else if (e.key === "Tab") {
			e.preventDefault()
			cycle(root, e.shiftKey)
		}
	}

	async function focusInitial(): Promise<void> {
		await nextTick()
		const root = panel.value
		if (!active || !root?.isConnected) return
		;(root.querySelector<HTMLElement>("[data-autofocus]") ?? root).focus()
	}

	function start(): void {
		active = true
		returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : null
		document.addEventListener("keydown", onKeydown)
		void focusInitial()
	}

	function stop(): void {
		if (!active) return
		active = false
		document.removeEventListener("keydown", onKeydown)
		if (returnTo?.isConnected && !panel.value?.contains(returnTo)) returnTo.focus()
		returnTo = null
	}

	watch(opts.enabled, (on) => (on ? start() : stop()), { immediate: true })
	onScopeDispose(stop)
}
