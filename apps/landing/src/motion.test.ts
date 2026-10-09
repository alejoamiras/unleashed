import { describe, expect, test } from "vitest"
import { MAX_FRAME_MS, type MotionState, motionLabel, playing, shouldRun, Ticker } from "./motion.ts"

describe("Ticker", () => {
	test("steps once per tick, at most once a frame, and never banks more than one tick", () => {
		const ticker = new Ticker(100)
		expect(ticker.advance(60)).toBe(false)
		expect(ticker.advance(60)).toBe(true) // 120: one step, 20 carried
		expect(ticker.advance(80)).toBe(true) // 100
		expect(ticker.advance(MAX_FRAME_MS * 10)).toBe(true) // clamped to 250: one step, 100 carried
		expect(ticker.advance(0)).toBe(true) // the carried tick
		expect(ticker.advance(0)).toBe(false)
	})
})

describe("motion state", () => {
	const state = (patch: Partial<MotionState>): MotionState => ({ reduce: false, userChoice: null, hidden: false, ...patch })

	test("reduced motion starts still; the visitor's choice wins over it both ways", () => {
		expect(playing(state({ reduce: true }))).toBe(false)
		expect(playing(state({ reduce: true, userChoice: "play" }))).toBe(true)
		// A media query change only flips `reduce`, so a manual Pause survives it.
		expect(playing(state({ reduce: false, userChoice: "pause" }))).toBe(false)
	})

	test("runs only when playing, shown and on screen", () => {
		expect(shouldRun(state({}), true)).toBe(true)
		expect(shouldRun(state({ hidden: true }), true)).toBe(false)
		expect(shouldRun(state({}), false)).toBe(false)
		expect(shouldRun(state({ userChoice: "pause" }), true)).toBe(false)
	})

	test("labels the canvas state the smoke reads", () => {
		expect(motionLabel(state({}), true)).toBe("running")
		expect(motionLabel(state({ reduce: true }), true)).toBe("still")
		expect(motionLabel(state({ reduce: true, userChoice: "pause" }), true)).toBe("paused")
		expect(motionLabel(state({}), false)).toBe("paused")
	})
})
