/**
 * After a reload: a record the store holds open is resumed by calling its claim again with the record as last
 * persisted, `watchOnly` so the page asks no wallet on load. The claim resumes from what the record names and never
 * sends while an earlier claim can still land. Typechecked with the package, never run.
 */
import { type DepositRecord, type DepositSecrets, isBridgeError, type Network, type Reads, type RunOptions } from "@unleashed/sdk"
import { claimToken } from "@unleashed/sdk/bridge"
import { type AztecSigner, claimFuel } from "@unleashed/sdk/fuel"
import { show } from "./fuel.ts"

export interface Held {
	record: DepositRecord
	secrets?: DepositSecrets
}

/** What the page tells the user about one open record. */
export type Resumed = "settled" | "reverted" | "awaiting-user" | "retry-now" | "retry-later" | "needs-attention"

export async function resume(net: Network, reads: Reads, aztec: AztecSigner, held: Held, persist: RunOptions["persist"]): Promise<Resumed> {
	const claim = held.record.intent === "gas" ? claimFuel : claimToken
	try {
		await claim(net, reads, aztec, held.record, {
			persist,
			onEvent: show,
			watchOnly: true,
			...(held.secrets ? { secrets: held.secrets } : {}),
		})
		return "settled"
	} catch (e) {
		if (!isBridgeError(e)) throw e
		// Nothing moved once the revert's block is final; until then a reorg can still land the deposit.
		if (e.code === "deposit-reverted" && e.submission === "submitted") return "reverted"
		// The next step asks the wallet: claim again, without `watchOnly`, when the user acts.
		if (e.code === "needs-prompt") return "awaiting-user"
		if (e.retry === "safe") return "retry-now"
		if (e.retry === "after-wait") return "retry-later"
		// Retrying could move funds twice or cannot succeed: keep the record and show `e.code`.
		return "needs-attention"
	}
}
