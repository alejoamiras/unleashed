import { computed, ref } from "vue"

/**
 * Module-scope registry of account-sensitive wallet operations (prompt/send spans).
 *
 * While any span is open, account switching is blocked at BOTH layers: the session's injected
 * `isSwitchBlocked` (the mutation boundary — selectAccount() rejects) and the AccountSwitcher UI
 * (disabled rows with a hint). An in-flight operation therefore always completes under the
 * account it captured at its start.
 *
 * The invariant for wrap sites: EVERY account-sensitive wallet prompt/send span runs inside
 * `withOperation` — drip, deposit, withdraw, fuel deposit, add-token, and each spawned journal
 * continuation (runDepositClaim / runWithdrawConsume — the single entry points for card retries,
 * resumeSessionWork, and the fuel claim leg). Read-only wallet queries are exempt.
 *
 * No operation spans a page reload (journal recovery re-derives from records), so the counter
 * needs no persistence.
 */
const inFlight = ref(0)

const busy = computed(() => inFlight.value > 0)

/** Run an account-sensitive operation inside a tracked span. Release is idempotent per
 *  invocation: it happens exactly once, in `finally`, whether fn resolves or throws. */
export async function withOperation<T>(fn: () => Promise<T>): Promise<T> {
	inFlight.value++
	try {
		return await fn()
	} finally {
		inFlight.value = Math.max(0, inFlight.value - 1)
	}
}

/** True while any tracked operation is in flight — the switch gate reads this. */
export function useOpsInFlight() {
	return { busy, withOperation }
}

/** Module-scope read for non-component call sites (session config wiring). */
export function opsInFlight(): boolean {
	return busy.value
}

/** Test-only: clear the counter between cases. */
export function __resetOpsInFlightForTests(): void {
	inFlight.value = 0
}
