import { onScopeDispose, ref, watch } from "vue"

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

/** Each section's address. `send` predates the Bridge label, so its key and its path differ. */
export const SECTION_PATHS: Readonly<Record<Section, string>> = {
	send: "/bridge",
	drip: "/faucet",
	activity: "/activity",
	addresses: "/addresses",
}

const BY_PATH = new Map((Object.entries(SECTION_PATHS) as [Section, string][]).map(([key, path]) => [path, key]))

/** The section a path names, ignoring case and one trailing slash; null for any other path, `/` included. */
export function sectionAt(pathname: string): Section | null {
	return BY_PATH.get(pathname.toLowerCase().replace(/(.)\/$/, "$1")) ?? null
}

const section = ref<Section>("send")
const highlightedId = ref<string | null>(null)
/** The send wizard is on one of its form steps (token, amount, review), whose footer is the real-funds line alone. */
const bridgeForm = ref(false)
/** The record whose receipt the send wizard shows reopened from Activity, else null: the footer lists the
 *  contracts as Activity's does, and the dock marks the record's row as the one on screen. */
const receiptFromActivity = ref<string | null>(null)
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

	/** A section link's click: a plain one switches in place; a modified one (new tab, new window) stays the browser's. */
	function follow(event: MouseEvent, next: Section): void {
		if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
		event.preventDefault()
		goTo(next)
	}

	return {
		section,
		highlightedId,
		bridgeForm,
		receiptFromActivity,
		prefill,
		receiptRequest,
		goTo,
		openActivity,
		follow,
		continueFromEthereum,
		takePrefill,
		showReceipt,
		takeReceiptRequest,
	}
}

/**
 * Bind the section to the address bar for the calling scope's lifetime. The path picks the section
 * at boot; any other path, `/` included, shows Bridge and is rewritten to /bridge without a history
 * entry. Every later switch pushes an entry, and Back/Forward switch back. The query string is kept.
 */
export function syncShellWithUrl(): void {
	// The URL is settled before the section moves, so the watcher below sees a path that already matches.
	function land(): void {
		const next = sectionAt(location.pathname) ?? "send"
		if (location.pathname !== SECTION_PATHS[next])
			history.replaceState(history.state, "", `${SECTION_PATHS[next]}${location.search}${location.hash}`)
		section.value = next
	}
	land()
	watch(
		section,
		(next) => {
			if (location.pathname !== SECTION_PATHS[next]) history.pushState(null, "", `${SECTION_PATHS[next]}${location.search}`)
		},
		{ flush: "sync" },
	)
	window.addEventListener("popstate", land)
	onScopeDispose(() => window.removeEventListener("popstate", land))
}

/** Test-only: back to the boot state, at the bare origin. */
export function __resetShellForTests(): void {
	section.value = "send"
	highlightedId.value = null
	bridgeForm.value = false
	receiptFromActivity.value = null
	prefill.value = null
	receiptRequest.value = null
	history.replaceState(null, "", "/")
}
