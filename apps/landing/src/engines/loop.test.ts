import { describe, expect, test } from "vitest"
import type { Engine } from "./engine.ts"
import { Loop } from "./loop.ts"

function fakeEngine(tick: number, fail = false): Engine & { steps: number } {
	return {
		tick,
		canvas: {} as HTMLCanvasElement,
		sizedBy: {} as Element,
		visible: true,
		steps: 0,
		resize() {},
		step() {
			if (fail) throw new Error("boom")
			this.steps++
		},
		draw() {},
	}
}

/** A hand-cranked requestAnimationFrame. */
function frames() {
	let queued: FrameRequestCallback[] = []
	return {
		schedule: (callback: FrameRequestCallback) => queued.push(callback),
		get waiting() {
			return queued.length
		},
		run(now: number) {
			const due = queued
			queued = []
			for (const callback of due) callback(now)
		},
	}
}

describe("Loop", () => {
	test("steps each engine on its own tick", () => {
		const clock = frames()
		const fast = fakeEngine(50)
		const slow = fakeEngine(150)
		const loop = new Loop(
			() => true,
			() => {},
			clock.schedule,
		)
		loop.add(fast)
		loop.add(slow)
		for (let t = 0; t <= 300; t += 50) clock.run(t)
		expect(fast.steps).toBe(6)
		expect(slow.steps).toBe(2)
	})

	test("requests no frames while nothing can run, and wakes on demand", () => {
		const clock = frames()
		let running = true
		const loop = new Loop(
			() => running,
			() => {},
			clock.schedule,
		)
		loop.add(fakeEngine(50))
		expect(clock.waiting).toBe(1)
		running = false
		clock.run(0)
		expect(clock.waiting).toBe(0)
		loop.wake()
		expect(clock.waiting).toBe(0)
		running = true
		loop.wake()
		loop.wake()
		expect(clock.waiting).toBe(1)
	})

	test("drops an engine that throws, reports it, and keeps the others running", () => {
		const clock = frames()
		const failed: Engine[] = []
		const bad = fakeEngine(50, true)
		const good = fakeEngine(50)
		const loop = new Loop(
			() => true,
			(engine) => failed.push(engine),
			clock.schedule,
		)
		loop.add(bad)
		loop.add(good)
		for (let t = 0; t <= 200; t += 50) clock.run(t)
		expect(failed).toEqual([bad])
		expect(good.steps).toBe(4)
	})
})
