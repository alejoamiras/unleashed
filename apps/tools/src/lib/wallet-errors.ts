/**
 * Explicit user-rejection classification. The cleanup matrix may DISCARD a pre-tx
 * record only when the user demonstrably said no - never on ambiguous failures (RPC outages,
 * wallet crashes), which must keep the record. So this walks the error's cause chain looking for
 * EXPLICIT signals only:
 *  - EIP-1193 `code: 4001` (userRejectedRequest - MetaMask/Rabby raw errors)
 *  - viem's `UserRejectedRequestError` (name match anywhere in the chain)
 *  - the Aztec wallet's explicit decline wordings ("rejected by user", "capability denied by user")
 */
export function isUserRejection(err: unknown): boolean {
	let current: unknown = err
	for (let depth = 0; depth < 6 && current && typeof current === "object"; depth++) {
		const e = current as { code?: unknown; name?: unknown; message?: unknown; cause?: unknown }
		if (e.code === 4001) return true
		if (e.name === "UserRejectedRequestError") return true
		if (typeof e.message === "string" && /rejected by user|user rejected the request|capability denied by user/i.test(e.message)) {
			return true
		}
		current = e.cause
	}
	return false
}

/** Translate wallet-plumbing errors into human copy; unknown messages pass through untouched. */
export function humanizeWalletError(message: string): string {
	if (/timed out waiting for window/i.test(message)) {
		return "The wallet's confirmation window timed out before you could sign. Reopen your wallet and retry."
	}
	return message
}
