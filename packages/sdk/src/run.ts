import type { Fr } from "@aztec-labs/aztec.js/fields"
import { BridgeError, type Submission } from "./errors.ts"
import type { TransferEvent } from "./events.ts"
import type { DepositRecord } from "./records.ts"

/** The salts a private transfer is claimed with. They are never in a record or an event: store them sealed. */
export interface DepositSecrets {
	claimSalt?: Fr
	fuelSalt?: Fr
}

export interface RunOptions {
	/** Awaited before the first wallet prompt, then before each event that names a new fact. A rejection before the
	 *  signature aborts with nothing signed. */
	persist(record: DepositRecord, secrets?: DepositSecrets): Promise<void>
	/** Display only; a throw here never changes the run. */
	onEvent?(e: TransferEvent): void
	/** Stops waiting; never cancels a sent transaction, and is not honoured between a send and its persist. */
	signal?: AbortSignal
}

/** Persists or throws `persist-failed`. After a submission the record already persisted names the deposit, so a
 *  retry must reconcile from it rather than send again. */
export async function persistOr(run: RunOptions, record: DepositRecord, submission: Submission, secrets?: DepositSecrets): Promise<void> {
	try {
		await run.persist(record, secrets)
	} catch (e) {
		const retry = submission === "none" ? "safe" : "never"
		throw new BridgeError("persist-failed", "the caller's storage refused the record", submission, retry, { cause: e })
	}
}

/** Throws `aborted` when the caller's signal fired; for safe points only. */
export function checkAbort(run: RunOptions, submission: Submission): void {
	if (!run.signal?.aborted) return
	throw new BridgeError("aborted", "the caller stopped waiting", submission, submission === "none" ? "safe" : "after-wait", {
		cause: run.signal.reason,
	})
}

/** Resolves with `p`, or throws `aborted` when the caller's signal fires first; the work itself is not cancelled. */
export function untilAborted<T>(p: Promise<T>, run: RunOptions, submission: Submission): Promise<T> {
	const signal = run.signal
	if (!signal) return p
	return new Promise<T>((resolve, reject) => {
		const onAbort = () =>
			reject(new BridgeError("aborted", "the caller stopped waiting", submission, "after-wait", { cause: signal.reason }))
		if (signal.aborted) return onAbort()
		signal.addEventListener("abort", onAbort, { once: true })
		p.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort))
	})
}
