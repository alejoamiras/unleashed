/**
 * Bridge progress model — turns raw L1<->L2 wait state into a UI-friendly fill
 * fraction + label.
 *
 * L2->L1 (Outbox proving) exposes proven-vs-needed block numbers, so we render
 * a genuine "N blocks remaining" bar. L1->L2 (Inbox inclusion) has no clean
 * block count, so we fall back to an elapsed/maxWait time estimate — capped
 * below 100% so the bar never reads "done" before the message is actually
 * consumable (the reference bridge's weak point: a bar that lies about ETA).
 */

export interface ProgressInput {
	/** L2->L1: the latest proven L2 checkpoint/block number. */
	provenBlock?: number
	/** L2->L1: the L2 block our message landed in (consumable once proven >= this). */
	neededBlock?: number
	/** L2->L1: the proven block when the wait started (fraction baseline). */
	startBlock?: number
	/** Elapsed wait so far (ms). */
	elapsedMs: number
	/** Expected upper bound on the wait (ms), for the time-based estimate. */
	maxWaitMs: number
	/** Rough seconds per block for the "~M min" estimate (testnet default ~36s). */
	secondsPerBlock?: number
}

export interface BridgeProgress {
	/** 0..1 fill for the bar. Capped at 0.95 until `done`. */
	fillFraction: number
	/** Human label, e.g. "12 blocks remaining (~7 min)" or "~3 min remaining". */
	label: string
	/** True when no fraction can be estimated (render a spinner). */
	indeterminate: boolean
	/** Set on the block-based (L2->L1) path. */
	blocksRemaining?: number
	/** True once the message is consumable. */
	done: boolean
}

/** Fraction is capped here until the wait is genuinely done. */
export const PROGRESS_CAP = 0.95

function clamp(x: number, lo: number, hi: number): number {
	return Math.max(lo, Math.min(hi, x))
}

function minutes(ms: number): number {
	return Math.max(0, Math.round(ms / 60_000))
}

/** Compute the bar from block-based (preferred) or time-based wait state. */
export function computeProgress(input: ProgressInput): BridgeProgress {
	const { provenBlock, neededBlock, startBlock, elapsedMs, maxWaitMs, secondsPerBlock = 36 } = input

	// L2->L1: genuine block-based progress.
	if (provenBlock !== undefined && neededBlock !== undefined) {
		const blocksRemaining = Math.max(0, neededBlock - provenBlock)
		if (blocksRemaining === 0) {
			return { fillFraction: 1, label: "Ready to claim", indeterminate: false, blocksRemaining: 0, done: true }
		}
		const base = startBlock ?? provenBlock
		const span = neededBlock - base
		const fraction = span > 0 ? clamp((provenBlock - base) / span, 0, PROGRESS_CAP) : 0
		const etaMin = minutes(blocksRemaining * secondsPerBlock * 1000)
		return {
			fillFraction: fraction,
			label: `${blocksRemaining} block${blocksRemaining === 1 ? "" : "s"} remaining (~${etaMin} min)`,
			indeterminate: false,
			blocksRemaining,
			done: false,
		}
	}

	// L1->L2: no clean block count — time-based estimate.
	if (maxWaitMs <= 0) {
		return { fillFraction: 0, label: "Waiting for inclusion…", indeterminate: true, done: false }
	}
	const fraction = clamp(elapsedMs / maxWaitMs, 0, PROGRESS_CAP)
	const remainingMin = minutes(maxWaitMs - elapsedMs)
	return {
		fillFraction: fraction,
		label: remainingMin > 0 ? `~${remainingMin} min remaining` : "Almost there…",
		indeterminate: false,
		done: false,
	}
}
