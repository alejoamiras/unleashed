import { describe, expect, it } from "vitest"
import { type BridgeProgress, computeProgress, PROGRESS_CAP } from "./progress"

describe("computeProgress — block-based (L2->L1)", () => {
	it("reports blocks remaining + a fraction mid-wait", () => {
		const p = computeProgress({ startBlock: 100, provenBlock: 110, neededBlock: 120, elapsedMs: 0, maxWaitMs: 0 })
		expect(p.blocksRemaining).toBe(10)
		expect(p.fillFraction).toBeCloseTo(0.5, 5) // (110-100)/(120-100)
		expect(p.label).toMatch(/10 blocks remaining/)
		expect(p.done).toBe(false)
	})

	it("is done (fraction 1, claimable) when proven >= needed", () => {
		const p = computeProgress({ startBlock: 100, provenBlock: 120, neededBlock: 120, elapsedMs: 0, maxWaitMs: 0 })
		expect(p.blocksRemaining).toBe(0)
		expect(p.fillFraction).toBe(1)
		expect(p.done).toBe(true)
		expect(p.label).toMatch(/ready to claim/i)
	})

	it("singularizes a 1-block remaining label", () => {
		const p = computeProgress({ startBlock: 100, provenBlock: 119, neededBlock: 120, elapsedMs: 0, maxWaitMs: 0 })
		expect(p.label).toMatch(/^1 block remaining/)
	})

	it("caps the fraction below 1 while blocks remain", () => {
		const p = computeProgress({ startBlock: 100, provenBlock: 119, neededBlock: 120, elapsedMs: 0, maxWaitMs: 0 })
		expect(p.fillFraction).toBeLessThanOrEqual(PROGRESS_CAP)
		expect(p.done).toBe(false)
	})

	it("includes an ETA derived from secondsPerBlock", () => {
		const p = computeProgress({
			provenBlock: 0,
			neededBlock: 10,
			startBlock: 0,
			elapsedMs: 0,
			maxWaitMs: 0,
			secondsPerBlock: 60,
		})
		// 10 blocks * 60s = 600s = 10 min
		expect(p.label).toMatch(/~10 min/)
	})
})

describe("computeProgress — time-based (L1->L2)", () => {
	it("fills proportionally to elapsed/maxWait", () => {
		const p = computeProgress({ elapsedMs: 60_000, maxWaitMs: 240_000 })
		expect(p.fillFraction).toBeCloseTo(0.25, 5)
		expect(p.label).toMatch(/~3 min remaining/)
		expect(p.blocksRemaining).toBeUndefined()
	})

	it("caps at PROGRESS_CAP and never reads done on overrun", () => {
		const p: BridgeProgress = computeProgress({ elapsedMs: 999_000, maxWaitMs: 240_000 })
		expect(p.fillFraction).toBe(PROGRESS_CAP)
		expect(p.done).toBe(false)
		expect(p.label).toMatch(/almost there/i)
	})

	it("is indeterminate when no wait bound is known", () => {
		const p = computeProgress({ elapsedMs: 10_000, maxWaitMs: 0 })
		expect(p.indeterminate).toBe(true)
		expect(p.fillFraction).toBe(0)
	})
})
