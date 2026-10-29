/** What a run reports as it goes, for display. Every event naming a fact (a hash, a leaf) follows its persist. */
import type { Hex } from "viem"

export type Leaves = {
	token?: { leafIndex: bigint; messageHash: Hex }
	fuel?: { leafIndex: bigint; messageHash: Hex; received: bigint }
}

export type TransferEventBody =
	| { type: "prepared" }
	| { type: "approval"; status: "requested" }
	| { type: "approval"; status: "sent" | "confirmed"; txHash: Hex }
	/** The approval is not mined after `round` receipt waits; the wait goes on. */
	| { type: "approval"; status: "waiting"; txHash: Hex; round: number }
	| { type: "signature-requested" }
	| { type: "deposit-sent"; txHash: Hex }
	| { type: "deposit-confirmed"; leaves: Leaves }
	| { type: "arrival"; stage: "counting" | "unfolded" | "wallet-sync"; blocksLeft?: number; checkpointsLeft?: number }
	| { type: "claimable" }
	/** The Aztec wallet is being asked for the token's first registration, or for the claim. */
	| { type: "registration-requested" }
	| { type: "claim-requested" }
	| { type: "registration-sent"; txHash: string }
	| { type: "claim-sent"; txHash: string; payer: "fuel" | "fpc-credit" | "own-gas" }
	| { type: "claim-proposed"; txHash: string }
	| { type: "settled"; via: "claim" | "claimed-elsewhere"; txHash?: string }

/** `seq` strictly increases within one call; `id` is the record's. */
export type TransferEvent = { id: string; seq: number } & TransferEventBody

export type Emit = (body: TransferEventBody) => void

/** An emitter for one call. A listener that throws is ignored: display never changes a run. */
export function eventEmitter(id: string, onEvent?: (e: TransferEvent) => void): Emit {
	let seq = 0
	return (body) => {
		if (!onEvent) return
		try {
			onEvent({ id, seq: seq++, ...body })
		} catch {
			// Display only.
		}
	}
}
