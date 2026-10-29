/**
 * After a reload: a record the store holds open is finished by calling its claim again with the record as last
 * persisted. The claim resumes from what the record names and never sends while an earlier claim can still land.
 * Typechecked with the package, never run.
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
export type Resumed = "settled" | "nothing-moved" | "retry-now" | "retry-later" | "needs-attention"

export async function resume(net: Network, reads: Reads, aztec: AztecSigner, held: Held, persist: RunOptions["persist"]): Promise<Resumed> {
	const claim = held.record.intent === "gas" ? claimFuel : claimToken
	try {
		await claim(net, reads, aztec, held.record, { persist, onEvent: show, ...(held.secrets ? { secrets: held.secrets } : {}) })
		return "settled"
	} catch (e) {
		if (!isBridgeError(e)) throw e
		// The deposit reverted on chain: the record can be dropped.
		if (e.code === "deposit-reverted" && e.submission === "submitted") return "nothing-moved"
		if (e.retry === "safe") return "retry-now"
		if (e.retry === "after-wait") return "retry-later"
		// Retrying could move funds twice or cannot succeed: keep the record and show `e.code`.
		return "needs-attention"
	}
}
