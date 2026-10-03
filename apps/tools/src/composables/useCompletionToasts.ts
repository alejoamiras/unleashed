import { watch } from "vue"
import { amountQualifier, displayAmountText } from "@/lib/asset-label"
import { etherscanTxUrl, explorerTxUrl } from "@/lib/explorer"
import { useBridgeJournal } from "./useBridgeJournal"
import { useToast } from "./useToast"

type Completed = NonNullable<ReturnType<typeof useBridgeJournal>["lastCompleted"]["value"]>

/** The record's own amount and symbol; the toast's kind draws the check, so the text carries none. */
function completionText(done: Completed): string {
	const what = `${displayAmountText(done.display)} ${done.display.symbol}`
	if (done.direction !== "deposit") return `Released ${what} to Ethereum`
	return done.assetKind === "fee-juice" ? `Fueled Aztec with ${what}` : `Bridged ${what} to Aztec`
}

function completionLink(done: Completed): { label: string; href: string } | undefined {
	if (!done.txHash) return undefined
	const href = done.direction === "deposit" ? explorerTxUrl(done.txHash) : etherscanTxUrl(done.txHash)
	return href ? { label: "View tx", href } : undefined
}

/**
 * Announces a bridge completing in the background. Mounted ONCE by the shell, so the announcement
 * neither depends on which section is visible nor doubles when two lists render the same records.
 */
export function useCompletionToasts(): void {
	const journal = useBridgeJournal()
	const { push } = useToast()
	watch(
		() => journal.lastCompleted.value,
		(done) => {
			if (!done) return
			// The foreground stepper shows the receipt for this completion — a toast would double it.
			// Keyed off the SYNCHRONOUS capture, not the live activeFlowId: the form's completion watcher
			// releases the takeover before this one runs, so the live check would always pass here.
			if (done.foreground) return
			const qualifier = amountQualifier(done.display)
			push({ kind: "ok", lead: completionText(done), ...(qualifier ? { text: qualifier } : {}), link: completionLink(done) })
		},
	)
}
