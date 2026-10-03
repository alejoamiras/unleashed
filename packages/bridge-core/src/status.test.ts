import { describe, expect, it } from "vitest"
import { depositStatus, withdrawStatus } from "./status"

describe("status — the loading-bar driver", () => {
	it("depositStatus is time-based (elapsed/maxWait)", () => {
		const p = depositStatus(0, 240_000, 60_000)
		expect(p.fillFraction).toBeCloseTo(0.25, 5)
		expect(p.label).toMatch(/~3 min remaining/)
		expect(p.blocksRemaining).toBeUndefined()
	})

	it("withdrawStatus reports N blocks remaining from the proven block", async () => {
		const node = { getProvenBlockNumber: async () => 110 }
		const p = await withdrawStatus(node, 120, 100)
		expect(p.blocksRemaining).toBe(10)
		expect(p.fillFraction).toBeCloseTo(0.5, 5)
		expect(p.label).toMatch(/10 blocks remaining/)
	})

	it("withdrawStatus is done (claimable) once proven >= needed", async () => {
		const node = { getProvenBlockNumber: async () => 120n }
		const p = await withdrawStatus(node, 120, 100)
		expect(p.done).toBe(true)
		expect(p.blocksRemaining).toBe(0)
	})
})
