import type { FeeStop } from "./execution/fee-stop.ts"

/**
 * Every failure the public API throws. `submission` says whether anything reached a chain for this transfer (a claim
 * refused before it reads anything says "none", though its deposit was sent), and `retry` whether the same call may
 * simply run again: "after-wait" means the chain has not caught up yet, "never" means retrying could move funds twice
 * or cannot succeed.
 */
export type BridgeErrorCode =
	| "invalid-request"
	| "invalid-network"
	| "wrong-chain"
	| "wrong-aztec-network"
	| "unsupported-line"
	| "user-rejected"
	| "persist-failed"
	| "no-fuel-route"
	| "fetch-unavailable"
	| "read-failed"
	| "quote-moved"
	| "below-floor"
	| "paused"
	| "approval-failed"
	| "deposit-reverted"
	| "deposit-not-found"
	| "receipt-mismatch"
	| "message-timeout"
	| "message-invalid"
	| "fee-stop"
	| "registration-dropped"
	| "registration-reverted"
	| "claim-not-visible"
	| "claim-reverted"
	| "receipt-timeout"
	| "aborted"

export type Submission = "none" | "submitted" | "unknown"
export type Retry = "safe" | "after-wait" | "never"

export class BridgeError extends Error {
	override readonly name = "BridgeError"
	/** For `fee-stop`: which stop, for the caller's own copy. */
	readonly stop?: FeeStop
	constructor(
		readonly code: BridgeErrorCode,
		message: string,
		readonly submission: Submission,
		readonly retry: Retry,
		options?: { cause?: unknown; stop?: FeeStop },
	) {
		super(message, options)
		if (options?.stop) this.stop = options.stop
	}
}

export const isBridgeError = (e: unknown): e is BridgeError => e instanceof BridgeError

/** A refusal before anything was signed or sent. */
export const refusal = (code: BridgeErrorCode, message: string, retry: Retry = "never", cause?: unknown): BridgeError =>
	new BridgeError(code, message, "none", retry, cause === undefined ? undefined : { cause })

/** EIP-1193's 4001, or viem's wrapper of it, anywhere on the cause chain. */
export function isUserRejection(e: unknown): boolean {
	for (let at: unknown = e, depth = 0; at && typeof at === "object" && depth < 8; depth++) {
		const o = at as { code?: unknown; name?: unknown; cause?: unknown }
		if (o.code === 4001 || o.name === "UserRejectedRequestError") return true
		at = o.cause
	}
	return false
}
