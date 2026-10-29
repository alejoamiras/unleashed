/**
 * Which source blocks a run reads, found from block timestamps: a chain's block time is its sequencer's setting (Base
 * Sepolia went from 2 s to 0.2 s blocks), so no block count stands for a time.
 */
import { SELF_BUILT_FILL_WINDOW_S } from "@unleashed/bridge-core/across-fill"

/**
 * How far before the destination's head time a run reads source blocks. An admitted deposit's deadline is at most
 * its block's timestamp plus the fill window (`classify` bounds the window; the pool refuses a quote later than its
 * block), so an older block holds nothing fillable. The 600 s more keep an expired deposit in the `skipped` lines.
 */
export const SCAN_WINDOW_S = BigInt(SELF_BUILT_FILL_WINDOW_S) + 600n
/** An ignored deposit is logged by the passes within this long of its block (about two), not for two hours. */
export const IGNORED_LOG_S = 30n
/** The most source blocks below the head a run reads: 2.5 times the window at 0.2 s blocks. */
export const MAX_SCAN_BLOCKS = 100_000n

export interface ScanWindow {
	/** The first block stamped at or after the window's start. */
	from: bigint
	/** The first block stamped within {@link IGNORED_LOG_S} of the head's time. */
	recentFrom: bigint
}

/** The first block in `[lo, hi]` stamped at or after `ts`, given that `hi` is; timestamps never decrease but repeat. */
async function firstAtOrAfter(stamp: (n: bigint) => Promise<bigint>, lo: bigint, hi: bigint, ts: bigint): Promise<bigint> {
	let [low, high] = [lo, hi]
	while (low < high) {
		const mid = (low + high) / 2n
		if ((await stamp(mid)) >= ts) high = mid
		else low = mid + 1n
	}
	return low
}

/**
 * The blocks up to `head` stamped at or after `since`. Throws when `head` is stamped before `since` (a source behind
 * the window) or when the window reaches past {@link MAX_SCAN_BLOCKS}: a run reads all of the window or none of it.
 */
export async function scanWindow(stamp: (n: bigint) => Promise<bigint>, head: bigint, since: bigint): Promise<ScanWindow> {
	const headTs = await stamp(head)
	if (headTs < since) throw new Error(`the source head ${head} is stamped ${since - headTs} s before the scan window`)
	const floor = head > MAX_SCAN_BLOCKS ? head - MAX_SCAN_BLOCKS : 0n
	// A floor stamped exactly at `since` may share that second with blocks below it.
	if (floor > 0n && (await stamp(floor)) >= since) throw new Error(`the scan window passes ${MAX_SCAN_BLOCKS} source blocks`)
	const from = await firstAtOrAfter(stamp, floor, head, since)
	return { from, recentFrom: await firstAtOrAfter(stamp, from, head, headTs - IGNORED_LOG_S) }
}
