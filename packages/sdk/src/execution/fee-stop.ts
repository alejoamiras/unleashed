import type { FuelClaimInteraction } from "./fuel-claim.ts"

/**
 * Why the claim side refused to go on, as a stable code: the host owns the words its user reads. A stop is
 * fail-closed by construction — nothing is sent after one, and a retry re-reads every piece of evidence.
 */
export type FeeStop =
	/** A persisted claim hash the node cannot be asked about: the record is corrupted or hand-edited. */
	| "malformed-claim-hash"
	/** The gas-only record's Fee Juice was already claimed by an included transaction. */
	| "fuel-already-claimed"
	/** A prior gas-only claim has no conclusive receipt yet: it may still land. */
	| "fuel-claim-pending"
	/** A prior private fuel claim has no conclusive receipt yet. */
	| "private-claim-pending"
	/** A prior public fuel attempt has no conclusive receipt yet; `-send` is the shorter refusal its send gives. */
	| "fuel-attempt-pending"
	| "fuel-attempt-pending-send"
	/** A consumed-shaped refusal whose nullifier did not reach a checkpoint within the poll. */
	| "consumed-unconfirmed"
	/** A consumed-shaped refusal whose nullifier could not be read. */
	| "consumed-unreadable"
	/** A standalone claim was sent and not included within the poll. */
	| "standalone-unconfirmed"
	/** The wallet could not say which max fees it submits under, so no ceiling can be priced. */
	| "unpriced-by-wallet"
	/** A private fueled record whose event-derived fuel facts are not read yet; a receipt rehydration can restore them. */
	| "private-fuel-unread"
	/** A private fueled record missing what only its backup holds (the salt), or with no deposit hash to re-read. */
	| "private-fuel-missing"
	/** The record names a PrivateFPC other than the network's. */
	| "fpc-drift"
	/** The bridged Fee Juice is under the send route's calibrated floor a private claim needs to pay for itself. */
	| "below-fuel-floor"
	/** A direct Fee Juice claim: no claimable message, no configured floor, under the floor, under the fee limit
	 *  at current fees, or missing the salt (private) or the secret (public) it is rebuilt from. */
	| "no-claimable-fuel"
	| "floor-unconfigured"
	| "below-claim-floor"
	| "fee-limit-spiked"
	| "missing-salt"
	| "missing-secret"
	/** The bridged Fee Juice is under the committed ceiling of the private transaction that spends it. */
	| "fuel-short"
	| "fuel-short-registering"
	/** Spent fuel pays from the FPC credit, which needs the wallet to read. */
	| "credit-needs-wallet"
	| "credit-unreadable"
	| "credit-short"
	| "credit-short-registering"
	/** A claim with no fresh Fee Juice message pays from held gas: none held, unread, or under the ceiling. */
	| "own-gas-none"
	| "own-gas-unverifiable"
	| "own-gas-short"
	/** The same for a private bridge, which pays only from private gas. */
	| "private-own-gas-none"
	| "private-own-gas-unverifiable"
	| "private-own-gas-short"
	/** Deposit-leg recovery: a record from before the send schema, a reverted deposit, a network without a
	 *  bridge, or a record whose fuel block was swapped while its leaves were read. */
	| "record-predates-send"
	| "deposit-reverted"
	| "no-bridge"
	| "record-changed"

/** A stop that surfaces as a throw: a claim interaction's simulate or send, or an action with no result shape. */
export class FeeStopError extends Error {
	override readonly name = "FeeStopError"
	readonly stop: FeeStop
	constructor(stop: FeeStop) {
		super(`claim stopped: ${stop}`)
		this.stop = stop
	}
}

/** A claim interaction that refuses before any wallet call; `sendStop` keeps the asymmetry where a send refuses in
 *  other terms than its simulate. */
export function feeStopInteraction(stop: FeeStop, sendStop: FeeStop = stop): FuelClaimInteraction {
	return {
		simulate: async () => {
			throw new FeeStopError(stop)
		},
		send: async () => {
			throw new FeeStopError(sendStop)
		},
	}
}
