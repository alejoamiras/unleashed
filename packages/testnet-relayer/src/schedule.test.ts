import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { PassBounds, RunOutcome, RunSummary } from "./run"
import { relayRun } from "./schedule"

const T = Date.UTC(2026, 9, 29, 12, 0)

beforeEach(() => {
	vi.useFakeTimers({ now: T })
})
afterEach(() => {
	vi.useRealTimers()
})

/** A pass that takes `ms[i]` on its i-th call, recording when each starts and whether another was still in flight. */
function passes(ms: number[], outcome: RunOutcome = "idle") {
	const starts: number[] = []
	const bounds: PassBounds[] = []
	let inFlight = 0
	let overlapped = false
	const pass = async (b: PassBounds): Promise<RunSummary> => {
		overlapped ||= inFlight > 0
		inFlight++
		bounds.push(b)
		await new Promise((r) => setTimeout(r, ms[starts.push((Date.now() - T) / 1_000) - 1] ?? 0))
		inFlight--
		return { outcome }
	}
	return { pass, starts, bounds, overlapped: () => overlapped }
}

/** `relayRun` for the cron time `T`, invoked at `at`, with the time it resolved (seconds after `T`). */
async function run(pass: (b: PassBounds) => Promise<RunSummary>, at = T) {
	vi.setSystemTime(at)
	let endedAt = Number.NaN
	const done = relayRun(pass, T).then((s) => {
		endedAt = (Date.now() - T) / 1_000
		return s
	})
	await vi.advanceTimersByTimeAsync(120_000)
	return { summaries: await done, endedAt }
}

it("runs four passes 15 s apart, one at a time, each bounded by a run end before the next cron", async () => {
	const busy = passes([10_000, 10_000, 10_000, 10_000])
	const { summaries, endedAt } = await run(busy.pass)
	expect(summaries).toHaveLength(4)
	expect(busy.starts).toEqual([0, 15, 30, 45])
	expect(busy.overlapped()).toBe(false)
	expect(busy.bounds.map((b) => b.runEnd - T)).toEqual([58_000, 58_000, 58_000, 58_000])
	expect(endedAt).toBeLessThan(58)
})

it("drops the slots a slow pass or a late start missed, and stops after a refused pass", async () => {
	// A pass that overran a slot is followed at the next slot, not at once.
	for (const [ms, starts] of [
		[20_000, [0, 30, 45]],
		[40_000, [0, 45]],
	] as const) {
		const slow = passes([ms])
		await run(slow.pass)
		expect(slow.starts).toEqual(starts)
		expect(slow.overlapped()).toBe(false)
	}
	const late = passes([])
	await run(late.pass, T + 50_000)
	expect(late.starts).toEqual([50])
	const refused = passes([], "refused")
	expect((await run(refused.pass)).summaries).toEqual([{ outcome: "refused" }])
})
