import { describe, expect, test } from "vitest"
import { BothWays, veiledSpan } from "./both.ts"
import type { Measure } from "./card.ts"
import { Drip } from "./drip.ts"
import { Tuner } from "./tuner.ts"

/** A fixed-pitch font: 6 px a character. */
const measure: Measure = (text) => text.length * 6

/** A seeded generator, so a model's run is the same every time. */
function seeded(seed: number): () => number {
	let a = seed >>> 0
	return () => {
		a = (a + 0x6d2b79f5) >>> 0
		let t = Math.imul(a ^ (a >>> 15), 1 | a)
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

describe("B2 Both ways", () => {
	test("sends move right and exits left, each lane staying between its ends", () => {
		const model = new BothWays(seeded(1), null)
		model.layout(480, 48, measure)
		expect(model.top.length).toBeGreaterThan(0)
		expect(model.bottom.length).toBeGreaterThan(0)
		const send = model.top[0]
		const exit = model.bottom[0]
		const [sendX, exitX] = [send.x, exit.x]
		model.step()
		expect(send.x - sendX).toBe(4)
		expect(exit.x - exitX).toBe(-4)
		for (let i = 0; i < 200; i++) model.step()
		for (const pill of model.top) expect(pill.x).toBeLessThan(model.end)
		for (const pill of model.bottom) expect(pill.x + pill.w).toBeGreaterThan(model.start)
		expect(model.bar).toBe(Math.round((model.start + model.end) / 2 / 4) * 4)
	})

	test("veils exactly the part of an amount past the bar", () => {
		const pill = { label: "250.00 USDC", w: 80, x: 0, y: 0, off: 0 }
		expect(veiledSpan({ ...pill, x: 100 }, 300)).toEqual([180, 180])
		expect(veiledSpan({ ...pill, x: 260 }, 300)).toEqual([301, 340])
		expect(veiledSpan({ ...pill, x: 400 }, 300)).toEqual([400, 480])
	})

	test("drops the lane captions on a narrow screen", () => {
		const model = new BothWays(seeded(2), null)
		model.layout(240, 48, measure)
		expect([model.start, model.end]).toEqual([4, 236])
	})
})

describe("F1 Drip", () => {
	test("a drop lands as a coin, and a coin reaching the wallet lights it", () => {
		const model = new Drip()
		model.layout(400, 48)
		let landed = false
		let lit = false
		for (let i = 0; i < 200; i++) {
			const [drops, coins] = [model.drops.length, model.coins.length]
			model.step()
			if (model.drops.length < drops + 1 && model.coins.length > coins) landed = true
			if (model.flash === 3) lit = true
		}
		expect(landed).toBe(true)
		expect(lit).toBe(true)
	})

	test("SIGNAL and NOISE take turns", () => {
		const model = new Drip()
		model.layout(400, 48)
		const tokens = model.coins.map((coin) => coin.token)
		expect(tokens.length).toBeGreaterThan(2)
		for (let i = 1; i < tokens.length; i++) expect(tokens[i]).not.toBe(tokens[i - 1])
	})
})

describe("N1 Tuner", () => {
	test("the scan wraps past the edge, and a hold stops it for its count", () => {
		const always = () => 0
		const model = new Tuner(always)
		model.layout(80, 48)
		model.step()
		expect(model.hold).toBe(6)
		const held = model.x
		for (let i = 0; i < 6; i++) model.step()
		expect(model.x).toBe(held)
		const never = new Tuner(() => 0.99)
		never.layout(80, 48)
		const seen = new Set<number>()
		for (let i = 0; i < 40; i++) {
			never.step()
			seen.add(never.x)
		}
		expect(Math.max(...seen)).toBe(10 + 12 - 1)
		expect(seen.has(0)).toBe(true)
	})
})
