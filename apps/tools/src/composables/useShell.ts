import { ref } from "vue"

/**
 * Which section the shell shows, and the record the Activity page should draw attention to. One
 * module-level state, like every other cross-component state in this app, so the wizard's
 * background strip can open Activity without a prop chain.
 */
export type Section = "send" | "drip" | "activity" | "addresses"

/**
 * A new Ethereum-origin send the wizard should open pre-filled: what a cross-chain deposit left in the
 * user's Ethereum wallet when it was delivered there instead of into Aztec.
 */
export interface EthereumPrefill {
	/** The ERC-20 on Ethereum, lower-case. */
	token: `0x${string}`
	/** Base units of `token`; absent when the record never learned the delivered amount. */
	amount?: bigint
	intent: "token" | "token+gas" | "gas"
	isPrivate: boolean
	/** The cross-chain record this send continues. */
	fromRecordId: string
}

/** A `bridge.*` host lands on Send; everywhere else the faucet is the front door. */
const section = ref<Section>("send")
const highlightedId = ref<string | null>(null)
/** The send wizard is on one of its form steps (token, amount, review): the only place the bridge footer shows. */
const bridgeForm = ref(false)
/** Requests the wizard consumes once: a pre-filled send, or the receipt of one record. */
const prefill = ref<EthereumPrefill | null>(null)
const receiptRequest = ref<string | null>(null)

export function useShell() {
	function goTo(next: Section): void {
		section.value = next
	}

	function openActivity(recordId?: string): void {
		highlightedId.value = recordId ?? null
		section.value = "activity"
	}

	/** Opens the Bridge section with `request` waiting for the wizard; a newer request replaces an untaken one. */
	function continueFromEthereum(request: EthereumPrefill): void {
		prefill.value = request
		section.value = "send"
	}

	/** Hands the waiting prefill to its one consumer; null when none waits. */
	function takePrefill(): EthereumPrefill | null {
		const taken = prefill.value
		prefill.value = null
		return taken
	}

	/** Opens the Bridge section asking the wizard to show `recordId`'s receipt. */
	function showReceipt(recordId: string): void {
		receiptRequest.value = recordId
		section.value = "send"
	}

	function takeReceiptRequest(): string | null {
		const taken = receiptRequest.value
		receiptRequest.value = null
		return taken
	}

	return {
		section,
		highlightedId,
		bridgeForm,
		prefill,
		receiptRequest,
		goTo,
		openActivity,
		continueFromEthereum,
		takePrefill,
		showReceipt,
		takeReceiptRequest,
	}
}

/** Test-only: back to the boot state. */
export function __resetShellForTests(): void {
	section.value = "send"
	highlightedId.value = null
	bridgeForm.value = false
	prefill.value = null
	receiptRequest.value = null
}
