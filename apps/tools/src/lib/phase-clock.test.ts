import { beforeEach, describe, expect, it } from "vitest"
import type { BridgePhase } from "./bridge-steps"
import { __resetPhaseClockForTests, dropPhaseClock, formatClock, formatElapsed, formatStamp, trackPhases } from "./phase-clock"

const phase = (key: BridgePhase["key"], state: BridgePhase["state"]): BridgePhase => ({ key, label: key.toUpperCase(), state })

describe("phase-clock (the labor-illusion timekeeper)", () => {
	beforeEach(() => __resetPhaseClockForTests())

	it("stamps active→done transitions and reports elapsedMs", () => {
		trackPhases("r1", [phase("deposit", "active"), phase("sync", "pending")], 1_000)
		const out = trackPhases("r1", [phase("deposit", "done"), phase("sync", "active")], 15_000)
		expect(out[0].elapsedMs).toBe(14_000)
		expect(out[1].startedAt).toBe(15_000)
	})

	it("phases already done at first sight (reload) get NO duration - honest degradation", () => {
		const out = trackPhases("r2", [phase("deposit", "done"), phase("sync", "active")], 5_000)
		expect(out[0].elapsedMs).toBeUndefined()
		expect(out[0].startedAt).toBeUndefined()
	})

	it("done stamps once; repeat calls never restamp", () => {
		trackPhases("r3", [phase("approve", "active")], 1_000)
		const a = trackPhases("r3", [phase("approve", "done")], 3_000)
		const b = trackPhases("r3", [phase("approve", "done")], 9_000)
		expect(a[0].elapsedMs).toBe(2_000)
		expect(b[0].elapsedMs).toBe(2_000)
	})

	it("RETRY honesty: a re-activated phase restarts its attempt timer", () => {
		trackPhases("r5", [phase("sync", "active")], 1_000)
		trackPhases("r5", [phase("sync", "done")], 5_000)
		// The gate re-runs after a retry: SYNC re-activates - the old attempt must not leak in.
		const re = trackPhases("r5", [phase("sync", "active")], 60_000)
		expect(re[0].startedAt).toBe(60_000)
		const done = trackPhases("r5", [phase("sync", "done")], 64_000)
		expect(done[0].elapsedMs).toBe(4_000)
	})

	it("RETRY honesty: a phase regressing to pending forgets its stale times", () => {
		trackPhases("r6", [phase("confirm", "active")], 1_000)
		// The retry path puts CONFIRM back to pending while SYNC re-runs - 8 minutes pass.
		trackPhases("r6", [phase("confirm", "pending")], 480_000)
		const out = trackPhases("r6", [phase("confirm", "active")], 500_000)
		expect(out[0].startedAt).toBe(500_000) // NOT 1_000 - no inherited pre-failure start.
	})

	it("dropPhaseClock forgets a record (discard path)", () => {
		trackPhases("r4", [phase("exit", "active")], 1_000)
		dropPhaseClock("r4")
		const out = trackPhases("r4", [phase("exit", "done")], 9_000)
		expect(out[0].elapsedMs).toBeUndefined()
	})

	it("formatElapsed: seconds, minutes, hours", () => {
		expect(formatElapsed(14_000)).toBe("14s")
		expect(formatElapsed(125_000)).toBe("2m 05s")
		expect(formatElapsed(4_320_000)).toBe("1h 12m")
	})

	it("formatClock: m:ss, then h:mm:ss, never negative", () => {
		expect(formatClock(0)).toBe("0:00")
		expect(formatClock(14_000)).toBe("0:14")
		expect(formatClock(160_000)).toBe("2:40")
		expect(formatClock(3_725_000)).toBe("1:02:05")
		expect(formatClock(-800)).toBe("0:00")
	})

	it("formatStamp: today, yesterday, then the date, on a local 24-hour clock", () => {
		const now = new Date(2026, 8, 30, 18, 5).getTime()
		expect(formatStamp(new Date(2026, 8, 30, 14, 22).getTime(), now)).toBe("today 14:22")
		expect(formatStamp(new Date(2026, 8, 29, 9, 10).getTime(), now)).toBe("yesterday 09:10")
		expect(formatStamp(new Date(2026, 8, 3, 0, 7).getTime(), now)).toBe("3 Sep 00:07")
	})
})
