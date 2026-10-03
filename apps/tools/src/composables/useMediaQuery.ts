import { onScopeDispose, ref, type Ref } from "vue"

/** The one-column phone layout; stylesheets repeat the literal, since a media rule cannot import it. */
export const PHONE_QUERY = "(max-width: 760px)"

/** A live `matchMedia` result; false wherever `matchMedia` is missing (SSR, bare jsdom). */
export function useMediaQuery(query: string): Ref<boolean> {
	const matches = ref(false)
	if (typeof window === "undefined" || !window.matchMedia) return matches
	const list = window.matchMedia(query)
	matches.value = list.matches
	const onChange = (e: MediaQueryListEvent) => {
		matches.value = e.matches
	}
	list.addEventListener("change", onChange)
	onScopeDispose(() => list.removeEventListener("change", onChange))
	return matches
}
