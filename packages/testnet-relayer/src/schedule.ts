/**
 * A cron run's passes. Cloudflare fires the cron once a minute, so a run makes up to four passes 15 s apart, one at a
 * time, and ends before the next cron fires.
 */
import type { PassBounds, RunSummary } from "./run"

export const PASSES = 4
export const PASS_INTERVAL_MS = 15_000
/** A run ends this long after its cron time, 2 s before the next one fires. */
export const RUN_MS = 58_000
/** A slot with less than this left before the run's end is skipped: a pass needs some seconds for its reads. */
const MIN_PASS_MS = 5_000

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Runs `pass` in the slots `scheduledTime + k × PASS_INTERVAL_MS`, each after the previous pass has ended, dropping
 * the slots a late start or a slow pass missed, and stops after a `refused` pass. Returns each pass's summary.
 */
export async function relayRun(pass: (bounds: PassBounds) => Promise<RunSummary>, scheduledTime: number): Promise<RunSummary[]> {
	const runEnd = scheduledTime + RUN_MS
	const summaries: RunSummary[] = []
	for (let k = 0; k < PASSES; k++) {
		k = Math.max(k, Math.floor((Date.now() - scheduledTime) / PASS_INTERVAL_MS))
		if (k >= PASSES) break
		const wait = scheduledTime + k * PASS_INTERVAL_MS - Date.now()
		if (wait > 0) await sleep(wait)
		if (runEnd - Date.now() < MIN_PASS_MS) break
		const summary = await pass({ runEnd })
		summaries.push(summary)
		if (summary.outcome === "refused") break
	}
	return summaries
}
