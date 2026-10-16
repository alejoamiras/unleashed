/** A frame longer than this counts as this long: a tab coming back from the background never fast-forwards. */
export const MAX_FRAME_MS = 250

/** Turns frame time into steps at a fixed rate. */
export class Ticker {
	private debt = 0

	constructor(readonly tickMs: number) {}

	/**
	 * Adds one frame's time; true when a step is due. At most one step per frame, and at most one tick
	 * of debt carried, so a slow frame never runs a burst of steps.
	 */
	advance(frameMs: number): boolean {
		this.debt += Math.min(Math.max(frameMs, 0), MAX_FRAME_MS)
		if (this.debt < this.tickMs) return false
		this.debt = Math.min(this.debt - this.tickMs, this.tickMs)
		return true
	}
}

export interface MotionState {
	/** prefers-reduced-motion */
	reduce: boolean
	/** The visitor's last press of Pause or Play; null until they press it. */
	userChoice: "play" | "pause" | null
	/** document.hidden */
	hidden: boolean
}

/** The visitor's own choice wins; until they make one, reduced motion means still. */
export function playing(state: MotionState): boolean {
	return state.userChoice === null ? !state.reduce : state.userChoice === "play"
}

export function shouldRun(state: MotionState, visible: boolean): boolean {
	return visible && !state.hidden && playing(state)
}

/** What a canvas reports in `data-state`. "still" is reduced motion before any choice. */
export function motionLabel(state: MotionState, visible: boolean): "running" | "paused" | "still" {
	if (shouldRun(state, visible)) return "running"
	return state.reduce && state.userChoice === null ? "still" : "paused"
}
