/**
 * B2, "Both ways", for the Bridge row: sends ride the Ethereum lane right and veil once past the bar;
 * exits ride the Aztec lane left and clear again once past it.
 */
import { bandTop, type CardModel, type Measure } from "./card.ts"
import { BODY_FONT, caption, laneDots, MONO_FONT, notchPath, StaticNoise, snap } from "./draw.ts"
import type { Palette } from "./engine.ts"

export const AMOUNTS = ["250.00 USDC", "0.42 WETH", "1,200.00 DAI", "18.75 LINK", "3,000.00 USDT", "64.10 UNI", "0.015 WBTC", "900.00 GHO"]

const PILL_H = 14
const STEP_PX = 4
const PREWARM_STEPS = 220
// Lane captions need this much room; narrower, the lanes run edge to edge.
const CAPTIONS_FROM = 260

export interface Pill {
	readonly label: string
	readonly w: number
	x: number
	readonly y: number
	/** Where this pill reads the static tile, so neighbours do not shimmer in step. */
	readonly off: number
}

/** The part of a pill on the Aztec side of the bar, which is the part drawn as static. */
export function veiledSpan(pill: Pill, bar: number): readonly [number, number] {
	const cut = Math.max(pill.x, Math.min(pill.x + pill.w, bar + 1))
	return [cut, pill.x + pill.w]
}

export class BothWays implements CardModel {
	readonly tick = 70
	top: Pill[] = []
	bottom: Pill[] = []
	bar = 0
	start = 0
	end = 0
	private ya = 0
	private yb = 0
	private oy = 0
	private width = 0
	private next = 0
	private gapTop = 0
	private gapBottom = 0
	private measure: Measure = () => 0

	constructor(
		private readonly rand: () => number,
		private readonly noise: StaticNoise | null,
	) {
		this.next = Math.floor(rand() * AMOUNTS.length)
	}

	layout(width: number, height: number, measure: Measure): void {
		this.width = width
		this.measure = measure
		this.oy = bandTop(height)
		this.ya = this.oy + 6
		this.yb = this.oy + 28
		const captions = width >= CAPTIONS_FROM
		this.start = captions ? snap(measure("Ethereum", `700 10px ${BODY_FONT}`) + 18, 4) : 4
		this.end = captions ? width - snap(measure("Aztec", `700 10px ${BODY_FONT}`) + 18, 4) : width - 4
		this.bar = snap((this.start + this.end) / 2, 4)
		this.top = []
		this.bottom = []
		this.gapTop = 0
		this.gapBottom = 20
		for (let i = 0; i < PREWARM_STEPS; i++) this.advance()
	}

	step(): void {
		this.advance()
		this.noise?.shuffle()
	}

	private make(rightward: boolean): Pill {
		const label = AMOUNTS[this.next++ % AMOUNTS.length]
		const w = snap(this.measure(label, `500 10px ${MONO_FONT}`) + 12, 4)
		return { label, w, x: rightward ? this.start - w : this.end, y: rightward ? this.ya : this.yb, off: Math.floor(this.rand() * 40) }
	}

	private advance(): void {
		for (const pill of this.top) pill.x += STEP_PX
		for (const pill of this.bottom) pill.x -= STEP_PX
		this.top = this.top.filter((pill) => pill.x < this.end)
		this.bottom = this.bottom.filter((pill) => pill.x + pill.w > this.start)
		this.gapTop -= STEP_PX
		if (this.gapTop <= 0) {
			const pill = this.make(true)
			this.top.push(pill)
			this.gapTop = pill.w + STEP_PX * (5 + Math.floor(this.rand() * 9))
		}
		this.gapBottom -= STEP_PX
		if (this.gapBottom <= 0) {
			const pill = this.make(false)
			this.bottom.push(pill)
			this.gapBottom = pill.w + STEP_PX * (7 + Math.floor(this.rand() * 11))
		}
	}

	draw(ctx: CanvasRenderingContext2D, palette: Palette): void {
		laneDots(ctx, palette, this.ya + 6, this.start, this.end)
		laneDots(ctx, palette, this.yb + 6, this.start, this.end)
		if (this.start > 4) {
			caption(ctx, palette, "Ethereum", 8, this.oy + 24)
			caption(ctx, palette, "Aztec", this.width - 8, this.oy + 24, "end")
		}
		ctx.save()
		ctx.beginPath()
		ctx.rect(this.start - 2, 0, this.end - this.start + 4, this.oy + 48)
		ctx.clip()
		for (const pill of [...this.top, ...this.bottom]) {
			const [cut, stop] = veiledSpan(pill, this.bar)
			this.drawPill(ctx, palette, pill, pill.x, cut, false)
			this.drawPill(ctx, palette, pill, cut, stop, true)
		}
		ctx.restore()
		ctx.fillStyle = palette.signal
		ctx.fillRect(this.bar, this.oy + 2, 2, 44)
	}

	/** One horizontal slice of a pill: clear (its amount on a raised fill) or veiled (static). */
	private drawPill(ctx: CanvasRenderingContext2D, palette: Palette, pill: Pill, from: number, to: number, veiled: boolean): void {
		if (to <= from) return
		ctx.save()
		ctx.beginPath()
		ctx.rect(from, pill.y - 1, to - from, PILL_H + 2)
		ctx.clip()
		notchPath(ctx, pill.x, pill.y, pill.w, PILL_H, 2)
		if (veiled && this.noise) {
			ctx.clip()
			ctx.drawImage(this.noise.canvas, pill.off, 0, Math.ceil(pill.w / 2), StaticNoise.HEIGHT, pill.x, pill.y, pill.w, PILL_H)
		} else {
			ctx.fillStyle = palette.raised
			ctx.fill()
			ctx.fillStyle = palette.ink
			ctx.font = `500 10px ${MONO_FONT}`
			ctx.textBaseline = "middle"
			ctx.fillText(pill.label, pill.x + 6, pill.y + PILL_H / 2 + 1)
		}
		ctx.restore()
	}
}
