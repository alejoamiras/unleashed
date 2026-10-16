import { Ticker } from "../motion.ts"
import type { Engine } from "./engine.ts"

type Schedule = (callback: FrameRequestCallback) => number

/**
 * The page's one animation loop. Each engine steps on its own tick. When no engine can run, the
 * loop requests no frames at all until `wake()`. An engine that throws, here or in any `guard`ed
 * call, is dropped and reported, and the rest keep running.
 */
export class Loop {
	private readonly engines = new Map<Engine, Ticker>()
	private pending = false
	private last: number | null = null

	constructor(
		private readonly canRun: (engine: Engine) => boolean,
		private readonly onFail: (engine: Engine, error: unknown) => void,
		// Looked up per call, so a wrapped requestAnimationFrame (the smoke counts calls) is the one used.
		private readonly schedule: Schedule = (callback) => requestAnimationFrame(callback),
	) {}

	add(engine: Engine): void {
		this.engines.set(engine, new Ticker(engine.tick))
		this.wake()
	}

	/** Call after anything that can let an engine run: Play, a visible canvas, a shown tab. */
	wake(): void {
		if (this.pending || ![...this.engines.keys()].some(this.canRun)) return
		this.pending = true
		this.last = null
		this.schedule(this.frame)
	}

	private readonly frame = (now: number): void => {
		this.pending = false
		const elapsed = this.last === null ? 0 : now - this.last
		this.last = now
		let ran = false
		for (const [engine, ticker] of this.engines) {
			if (!this.canRun(engine)) continue
			ran = true
			if (ticker.advance(elapsed)) this.stepOne(engine)
		}
		if (ran) {
			this.pending = true
			this.schedule(this.frame)
		}
	}

	/** Runs one engine's work outside a frame (a start, a resize, a redraw) under the same failure rule. */
	guard(engine: Engine, work: () => void): void {
		try {
			work()
		} catch (error) {
			this.engines.delete(engine)
			this.onFail(engine, error)
		}
	}

	private stepOne(engine: Engine): void {
		this.guard(engine, () => {
			engine.step()
			engine.draw()
		})
	}
}
