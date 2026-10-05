import { ref } from "vue"

/**
 * Which section the shell shows, and the record the Activity page should draw attention to. One
 * module-level state, like every other cross-component state in this app, so the wizard's
 * background strip can open Activity without a prop chain.
 */
export type Section = "send" | "drip" | "activity" | "addresses"

/** A `bridge.*` host lands on Send; everywhere else the faucet is the front door. */
const section = ref<Section>("send")
const highlightedId = ref<string | null>(null)
/** The send wizard is on one of its form steps (token, amount, review): the only place the bridge footer shows. */
const bridgeForm = ref(false)

export function useShell() {
	function goTo(next: Section): void {
		section.value = next
	}

	function openActivity(recordId?: string): void {
		highlightedId.value = recordId ?? null
		section.value = "activity"
	}

	return { section, highlightedId, bridgeForm, goTo, openActivity }
}

/** Test-only: back to the boot state. */
export function __resetShellForTests(): void {
	section.value = "send"
	highlightedId.value = null
	bridgeForm.value = false
}
