/** What a run reports as it goes, for display. Every event naming a fact (a hash, a leaf) follows its persist. */
import type { Hex } from "viem"

export type Leaves = {
	token?: { leafIndex: bigint; messageHash: Hex }
	fuel?: { leafIndex: bigint; messageHash: Hex; received: bigint }
}

/** Which claim of a transfer an event names: the token claim, or the bridged gas claimed on its own. */
export type ClaimLeg = "token" | "gas"

export type TransferEventBody =
	| { type: "prepared" }
	| { type: "approval"; status: "requested" }
	| { type: "approval"; status: "sent" | "confirmed"; txHash: Hex }
	/** The approval is not mined after `round` receipt waits; the wait goes on. */
	| { type: "approval"; status: "waiting"; txHash: Hex; round: number }
	| { type: "signature-requested" }
	| { type: "deposit-sent"; txHash: Hex }
	| { type: "deposit-confirmed"; leaves: Leaves }
	/** A claim recovering what its record lost: the search for a deposit the record never stored, the read of its
	 *  receipt, and `waiting` when that deposit is not mined yet and the run waits for Ethereum to confirm it. */
	| { type: "deposit-recovery"; stage: "searching" }
	| { type: "deposit-recovery"; stage: "reading" | "waiting"; txHash: Hex }
	/** `counting` reads the L2 block (`block`, `blocksLeft`) or the checkpoints still to pass, a count that never rises
	 *  within a call and ends at 0; `wallet-sync` comes before each claim simulate, `counted` once a gate waited. */
	| { type: "arrival"; stage: "counting"; block?: number; blocksLeft?: number; checkpointsLeft?: number }
	| { type: "arrival"; stage: "unfolded" }
	| { type: "arrival"; stage: "wallet-sync"; counted: boolean }
	| { type: "claimable" }
	/** The Aztec wallet is asked next: for the token's first registration, or for a claim (once per attempt, even
	 *  when a lost registration race sends the plain claim instead). */
	| { type: "registration-requested" }
	| { type: "claim-requested"; leg: ClaimLeg }
	| { type: "registration-sent"; txHash: string }
	| { type: "claim-sent"; leg: ClaimLeg; txHash: string; payer: "fuel" | "fpc-credit" | "own-gas" }
	/** Before each receipt read of a watched claim (`poll` counts from 1 per hash), and again with the same `poll` when
	 *  that read changes the count of consecutive reads the node did not answer. */
	| { type: "claim-waiting"; leg: ClaimLeg; txHash: string; poll: number; unreachable: number }
	| { type: "claim-proposed"; txHash: string }
	/** A claim this call did not send landed; its message's nullifier is being read, or does not show yet. */
	| { type: "claim-verifying"; leg: ClaimLeg; txHash: string; stage: "checking" | "wallet-sync" }
	/** The tokens are claimed, before any claim of the gas they left: a failure after this is the gas claim's. */
	| { type: "claim-landed"; via: "claim" | "claimed-elsewhere"; txHash?: string }
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
