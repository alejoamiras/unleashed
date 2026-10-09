/** N1, "Tuner", for the open slot: a scan line sweeps the dots looking for a signal, and now and then holds. */
import type { CardModel } from "./card.ts"
import { dotGrid } from "./draw.ts"
import type { Palette } from "./engine.ts"

const COLUMN_PX = 8
// The line runs this many columns past the edge before it wraps, so a sweep reads as leaving.
const OFFSCREEN_COLUMNS = 12
const HOLD_CHANCE = 0.04

export class Tuner implements CardModel {
	readonly tick = 120
	/** The scan line's column. */
	x = 0
	/** Steps left of the current hold. */
	hold = 0
	private cols = 0
	private width = 0
	private height = 0

	constructor(private readonly rand: () => number) {}

	layout(width: number, height: number): void {
		this.width = width
		this.height = height
		this.cols = Math.ceil(width / COLUMN_PX)
		this.x = Math.floor(this.cols * 0.3)
	}

	step(): void {
		if (this.hold) {
			this.hold--
			return
		}
		this.x = (this.x + 1) % (this.cols + OFFSCREEN_COLUMNS)
		if (this.rand() < HOLD_CHANCE) this.hold = 6 + Math.floor(this.rand() * 8)
	}

	draw(ctx: CanvasRenderingContext2D, palette: Palette): void {
		dotGrid(ctx, palette.line, this.width, this.height)
		const trail = [palette.signal, palette.ink2, palette.ink3, palette.ink3]
		trail.forEach((color, behind) => {
			const col = this.x - behind
			if (col < 0 || col >= this.cols) return
			ctx.fillStyle = color
			for (let y = 5; y < this.height; y += 8) ctx.fillRect(col * COLUMN_PX + 5, y, 2, 2)
		})
		if (this.x < this.cols) {
			ctx.globalAlpha = 0.4
			ctx.fillStyle = palette.signal
			ctx.fillRect(this.x * COLUMN_PX + 9, 0, 2, this.height)
			ctx.globalAlpha = 1
		}
	}
}
