/**
 * The gates a deposit's claim waits through before it may send: a block countdown (display pacing only), the
 * checkpoint gate on the message keys the Inbox emitted, and the claim simulate, which is the one consumability
 * authority. Each takes its reads, its clock and its narration from the caller and holds no state.
 */
import { isMsgConsumed, isMsgNotReady } from "./message-errors.ts"
import type { TokenMessageState } from "./message-nullifier.ts"

/** L2 blocks between the deposit-time snapshot and presumed message arrival. */
export const SYNC_TARGET_MARGIN_BLOCKS = 3

/** Polls per gate, 6 s apart: about half an hour. */
const GATE_POLLS = 300
const GATE_POLL_MS = 6000

export interface ArrivalReads {
	l2BlockNumber?: () => Promise<number>
	/** The message's checkpoint and the node's anchor; the message is claimable once the anchor reaches it. Null, or a
	 *  rejection, while the node cannot place the message. */
	messageReadiness?: (messageHash: string) => Promise<{ checkpoint: number; anchor: number } | null>
}

export interface GateClock {
	wait(ms: number): Promise<void>
	/** True once the run no longer owns the record: the gate returns at its next step. */
	moved(): boolean
}

/** Threaded through the gates: `simulateStart` is the poll budget the countdown already spent of the simulate's;
 *  `counted` is set once any gate actually waited; `preGated` marks a record already known claimable. */
export interface ArrivalGateState {
	simulateStart: number
	counted: boolean
	preGated: boolean
}

export interface ArrivalNarration {
	/** The countdown read `current`, `left` blocks short of its target (zero once reached). */
	block?(current: number, left: number): void
	/** A message key the node does not answer for yet. */
	unfolded?(): void
	/** `reported` checkpoints still to pass; `first` on the first reading of this gate. */
	checkpointsLeft?(reported: number, first: boolean): void
	checkpointsPassed?(): void
	/** Before each claim simulate. */
	consumableWait?(gate: ArrivalGateState): void
	/** The simulate said not yet; `poll` counts from one. */
	notReady?(poll: number): void
}

/** Display pacing from the deposit-time L2 block plus a margin. Never an authority: it can only delay. A failed read
 *  ends it, and the checkpoint gate narrates from there. */
export async function awaitL2BlockCountdown(
	depositL2Block: number | undefined,
	reads: ArrivalReads,
	clock: GateClock,
	gate: ArrivalGateState,
	narrate: ArrivalNarration = {},
): Promise<ArrivalGateState> {
	let { simulateStart: i, counted } = gate
	const read = reads.l2BlockNumber
	if (depositL2Block === undefined || !read) return gate
	const target = depositL2Block + SYNC_TARGET_MARGIN_BLOCKS
	while (i < GATE_POLLS) {
		let current: number
		try {
			current = await read()
		} catch {
			break
		}
		if (current >= target) {
			narrate.block?.(current, 0)
			break
		}
		counted = true
		narrate.block?.(current, target - current)
		await clock.wait(GATE_POLL_MS)
		i++
	}
	return { ...gate, simulateStart: i, counted }
}

/** Polls the message keys the Inbox emitted (the token message and, on a gas leg, the Fee Juice one) until the
 *  node's anchor reaches every one's checkpoint: before that the claim's membership witness cannot exist. */
export async function awaitMessageCheckpoints(
	messageHashes: readonly string[],
	reads: ArrivalReads,
	clock: GateClock,
	gate: ArrivalGateState,
	narrate: ArrivalNarration = {},
): Promise<ArrivalGateState> {
	let counted = gate.counted
	const readiness = reads.messageReadiness
	if (!readiness || messageHashes.length === 0) return gate
	let first = true
	for (let g = 0; g < GATE_POLLS && !clock.moved(); g++) {
		const blocked = await firstBlocked(messageHashes, readiness)
		if (blocked === null) {
			narrate.checkpointsPassed?.()
			break
		}
		counted = true
		if (blocked === "unfolded") narrate.unfolded?.()
		else {
			narrate.checkpointsLeft?.(Math.max(blocked.checkpoint - blocked.anchor, 0), first)
			first = false
		}
		await clock.wait(GATE_POLL_MS)
	}
	return { ...gate, counted }
}

/** The first message not yet claimable: unanswered, or its checkpoint distance. Null when all are. */
async function firstBlocked(
	hashes: readonly string[],
	readiness: NonNullable<ArrivalReads["messageReadiness"]>,
): Promise<{ checkpoint: number; anchor: number } | "unfolded" | null> {
	for (const h of hashes) {
		const st = await readiness(h).catch(() => null)
		if (st === null) return "unfolded"
		if (st.anchor < st.checkpoint) return st
	}
	return null
}

export type ConsumableVerdict = "not-ready" | "claimed-elsewhere" | "invalid" | "error"

/** A simulate failure sorted: not anchored keeps polling; a consumed-shaped error is "claimed elsewhere" only once
 *  the chain's nullifier agrees (the simulate speaks for the wallet's view, the nullifier for the chain); every other
 *  case is an error. `nullifier` answers "unknown" when it cannot read. */
export async function classifyConsumable(e: unknown, nullifier: () => Promise<TokenMessageState>): Promise<ConsumableVerdict> {
	const msg = e instanceof Error ? e.message : String(e)
	if (isMsgNotReady(msg)) return "not-ready"
	if (!isMsgConsumed(msg)) return "error"
	const state = await nullifier()
	if (state === "nullified") return "claimed-elsewhere"
	if (state === "invalid") return "invalid"
	return "error"
}

/** The claim simulate, polled on the budget the countdown left, until it passes or says something other than not
 *  ready. An error verdict rethrows the simulate's own error. */
export async function awaitClaimSimulate(
	simulate: () => Promise<unknown>,
	classify: (e: unknown) => Promise<ConsumableVerdict>,
	clock: GateClock,
	gate: ArrivalGateState,
	narrate: ArrivalNarration = {},
): Promise<"ready" | "claimed-elsewhere" | "invalid" | "timeout" | "moved"> {
	for (let i = gate.simulateStart; i < GATE_POLLS; i++) {
		if (clock.moved()) return "moved"
		narrate.consumableWait?.(gate)
		try {
			await simulate()
			return "ready"
		} catch (e) {
			const verdict = await classify(e)
			if (verdict === "error") throw e
			if (verdict !== "not-ready") return verdict
			narrate.notReady?.(i + 1)
			await clock.wait(GATE_POLL_MS)
		}
	}
	return "timeout"
}
