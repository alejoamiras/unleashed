import type { Wallet } from "@aztec-labs/aztec.js/wallet"
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { ref } from "vue"
import { type NormalizedError, normalizeError } from "@/lib/errors"
import { withOperation } from "./useOpsInFlight"

/**
 * Local typed augmentation matching the runtime schema patch in
 * `@alejoamiras/nulo-wallet-sdk-schema-patch`. The cast in `addToken()` is the typed
 * boundary - the patch makes it true at runtime, this declaration makes
 * TypeScript agree.
 */
type WalletWithRegisterToken = Wallet & {
	registerToken(account: AztecAddress, token: AztecAddress): Promise<void>
	isTokenRegistered?(token: AztecAddress): Promise<boolean>
}

export type AddTokenStatus =
	| { kind: "idle" }
	| { kind: "submitting" }
	| { kind: "ok" }
	/** The user declined in the wallet. A cancel is not a failure: the UI must NOT
	 *  surface an error - return to idle silently. */
	| { kind: "rejected" }
	/** Dispatcher rejected the method by string (e.g. schema patch not in place
	 *  on the wallet side, or the wallet is too old). Distinct from a network
	 *  failure so the UI can guide the user to update. */
	| { kind: "unsupported" }
	| { kind: "error"; error: NormalizedError }

/**
 * Drive a one-click "Add to wallet" call against the connected wallet's
 * wallet-specific `registerToken` RPC. The wallet shows a confirmation prompt
 * (with resolved token name / symbol / decimals) before the call resolves.
 */
export function useAddDripToken() {
	const status = ref<AddTokenStatus>({ kind: "idle" })

	async function addToken(wallet: Wallet, accountAddress: string, tokenAddress: AztecAddress): Promise<void> {
		// Re-entrancy guard: ignore double-clicks while a previous call is
		// still in flight (the popup is open or the journal entry is being
		// written). Reset() returns the composable to a fresh state.
		if (status.value.kind === "submitting") return

		status.value = { kind: "submitting" }
		try {
			const w = wallet as WalletWithRegisterToken
			await w.registerToken(AztecAddress.fromStringUnsafe(accountAddress), tokenAddress)
			status.value = { kind: "ok" }
		} catch (err) {
			const normalized = normalizeError(err)
			const msg = `${normalized.message} ${err instanceof Error ? err.message : String(err)}`

			if (normalized.category === "user-rejected" || normalized.category === "capability-rejected") {
				// A cancel is silent (4001 → no error UI).
				status.value = { kind: "rejected" }
				return
			}

			const lowered = msg.toLowerCase()
			if (lowered.includes("unsupported wallet method") || lowered.includes("unknown wallet method")) {
				// Schema patch not in place on this wallet (or wallet too old).
				// Distinct from a network failure: tell the user to update the
				// wallet rather than retry blindly.
				status.value = { kind: "unsupported" }
				return
			}

			status.value = { kind: "error", error: normalized }
		}
	}

	function reset() {
		status.value = { kind: "idle" }
	}

	/**
	 * Whether the wallet already has this token registered (the capability-gated
	 * `isTokenRegistered` custom RPC). FAIL OPEN on any failure - older wallet builds,
	 * scope refusals, or transport errors must show the Add button, never hide it.
	 */
	async function isRegistered(wallet: Wallet, tokenAddress: AztecAddress): Promise<boolean> {
		try {
			const w = wallet as WalletWithRegisterToken
			if (typeof w.isTokenRegistered !== "function") return false
			return (await w.isTokenRegistered(tokenAddress)) === true
		} catch {
			return false
		}
	}

	// withOperation: an account-sensitive prompt/send span — while it runs, account switching is
	// blocked (useOpsInFlight).
	return { status, addToken: (...args: Parameters<typeof addToken>) => withOperation(() => addToken(...args)), isRegistered, reset }
}
