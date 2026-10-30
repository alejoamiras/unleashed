/**
 * A scripted stand-in for the SDK's claim entries and the app's claim context. A script plays one claim call on the
 * view the engine handed it, through the SDK's three channels: events (`run.onEvent`, numbered per call), awaited
 * writes (`run.persist`, a refusal surfacing as `persist-failed`) and the stop signal (`aborted` at the next checkpoint
 * after it fires).
 */
import { BridgeError, type BridgeErrorCode, type DepositRecord, type Network, type Reads, type TransferEventBody } from "@unleashed/sdk"
import type { AztecSigner, ClaimOptions, ClaimOutcome } from "@unleashed/sdk/fuel"
import { type Mock, vi } from "vitest"
import type { ClaimContext, ClaimEntry } from "../useBridgeJournal"

export const CLAIM_TX = "0x00140000000000000000000000000000000000000000000000636c61696d7478"

export type EntryName = "token" | "fuel"

/** One claim call as the fake SDK plays it. */
export interface ScriptedCall {
	readonly entry: EntryName
	/** The record as this call last persisted it; the view the engine passed until the first persist. */
	readonly record: DepositRecord
	readonly run: ClaimOptions
	/** Reports one event, then stops with `aborted` if the engine's signal fired meanwhile. */
	emit(body: TransferEventBody): void
	/** Writes a change to the running record, as the SDK's persist does: a refusal is `persist-failed`. */
	persist(patch: Partial<DepositRecord>): Promise<void>
	/** Waits for `until` (forever without one), stopping with `aborted` as soon as the signal fires. */
	hold(until?: Promise<unknown>): Promise<void>
	/** The landing and completion the SDK persists, and the outcome it returns. */
	settle(via?: ClaimOutcome["via"], extra?: Partial<ClaimOutcome>): Promise<ClaimOutcome>
}

export type ClaimScript = (call: ScriptedCall) => Promise<ClaimOutcome>

/** What the engine handed one call. */
export interface CallLog {
	entry: EntryName
	view: DepositRecord
	run: ClaimOptions
}

export const bridgeError = (
	code: BridgeErrorCode,
	opts: ConstructorParameters<typeof BridgeError>[4] = {},
	message: string = code,
): BridgeError => new BridgeError(code, message, "submitted", "never", opts)

const aborted = () => new BridgeError("aborted", "the caller stopped waiting", "submitted", "after-wait")

const legOf = (entry: EntryName) => (entry === "token" ? "token" : "gas")

/** The SDK's claim from the top: a call that may prompt sends the claim, then its receipt lands. A watching call with
 *  no claim sent stops where it would prompt, as `needs-prompt`. */
export const sendsClaim: ClaimScript = async (c) => {
	const leg = legOf(c.entry)
	if (!c.record.claimTxHash) {
		if (c.run.watchOnly) throw bridgeError("needs-prompt")
		c.emit({ type: "claim-requested", leg })
		await c.persist({ claimTxHash: CLAIM_TX })
		c.emit({ type: "claim-sent", leg, txHash: CLAIM_TX, payer: "own-gas" })
	}
	const txHash = c.record.claimTxHash as string
	c.emit({ type: "claim-waiting", leg, txHash, poll: 1, unreachable: 0 })
	return c.settle("claim", { txHash })
}

/** A claim whose receipt never lands: one `claim-waiting` per read until the engine stops the call. */
export const pollsForever: ClaimScript = async (c) => {
	const txHash = c.record.claimTxHash ?? CLAIM_TX
	for (let poll = 1; poll <= 1000; poll++) {
		c.emit({ type: "claim-waiting", leg: legOf(c.entry), txHash, poll, unreachable: 0 })
		await c.hold(Promise.resolve())
	}
	throw new Error("the engine never stopped the call")
}

export const failsWith =
	(e: unknown): ClaimScript =>
	async () => {
		throw e
	}

function scriptedCall(entry: EntryName, view: DepositRecord, run: ClaimOptions): ScriptedCall {
	let record = view
	let seq = 0
	const checkpoint = () => {
		if (run.signal?.aborted) throw aborted()
	}
	const call: ScriptedCall = {
		entry,
		run,
		get record() {
			return record
		},
		emit(body) {
			try {
				run.onEvent?.({ id: view.id, seq: seq++, ...body })
			} catch {
				// Display only, as in the SDK.
			}
			checkpoint()
		},
		async persist(patch) {
			record = { ...record, ...patch } as DepositRecord
			try {
				await run.persist(record)
			} catch (e) {
				throw new BridgeError("persist-failed", "the caller's storage refused the record", "submitted", "never", { cause: e })
			}
		},
		async hold(until) {
			checkpoint()
			const signal = run.signal
			await new Promise<void>((resolve, reject) => {
				const stop = () => reject(aborted())
				signal?.addEventListener("abort", stop, { once: true })
				until?.then(() => {
					signal?.removeEventListener("abort", stop)
					resolve()
				}, reject)
			})
		},
		async settle(via = "claim", extra = {}) {
			call.emit({ type: "claim-landed", via, txHash: extra.txHash })
			await call.persist({ completedAt: Date.now(), ...(via === "claimed-elsewhere" ? { claimedByOther: true } : {}) })
			call.emit({ type: "settled", via, txHash: extra.txHash })
			return { record, via, ...extra }
		},
	}
	return call
}

export const FAKE_NETWORK = { l1ChainId: 11155111, rollupVersion: 1 } as unknown as Network

export interface FakeClaimSdk {
	/** Spread into `connectJournalDeps`. */
	deps: { claimEntries: { token: ClaimEntry; fuel: ClaimEntry }; claimContext: ClaimContextFake }
	network: Mock<() => Promise<Network>>
	calls: CallLog[]
	/** The scripts an entry's next calls play, in order; the last repeats. */
	script(entry: EntryName, ...scripts: ClaimScript[]): void
}

type ClaimContextFake = Mock<(opts: { recipient: string; watchOnly: boolean }) => Promise<ClaimContext>>

/** Both entries default to `sendsClaim`; the context answers with `FAKE_NETWORK`. */
export function fakeClaimSdk(): FakeClaimSdk {
	const queues: Record<EntryName, ClaimScript[]> = { token: [sendsClaim], fuel: [sendsClaim] }
	const calls: CallLog[] = []
	const network = vi.fn(async () => FAKE_NETWORK)
	const entry =
		(name: EntryName): ClaimEntry =>
		(_net, _reads, _aztec, view, run) => {
			calls.push({ entry: name, view, run })
			const queue = queues[name]
			const script = (queue.length > 1 ? queue.shift() : queue[0]) as ClaimScript
			return script(scriptedCall(name, view, run))
		}
	const claimContext: ClaimContextFake = vi.fn(async () => ({
		reads: {} as Reads,
		aztec: { wallet: {}, account: {} } as unknown as AztecSigner,
		network: () => network(),
	}))
	return {
		deps: { claimEntries: { token: vi.fn(entry("token")), fuel: vi.fn(entry("fuel")) }, claimContext },
		network,
		calls,
		script(name, ...scripts) {
			queues[name] = scripts
		},
	}
}
