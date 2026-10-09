import { snap } from "./draw.ts"
import { context2d, type Engine, type Palette } from "./engine.ts"

/** Text width for a canvas font; a fixed-pitch stub in unit tests. */
export type Measure = (text: string, font: string) => number

/**
 * A card screen's behaviour without its canvas: state, a step, and a draw onto a context the host has
 * already cleared and scaled. Every model lays out from the size it is given, so a Strip (48 px tall)
 * and a Tile (72 px) need no code of their own.
 */
export interface CardModel {
	readonly tick: number
	layout(width: number, height: number, measure: Measure): void
	step(): void
	draw(ctx: CanvasRenderingContext2D, palette: Palette): void
}

/** The content band is 48 px tall, centred on a 2 px grid in a taller screen. */
export const bandTop = (height: number) => snap((height - 48) / 2, 2)

/** Hosts a model on a row's canvas: device-pixel sizing, the panel fill, and resizes. */
export class CardScreen implements Engine {
	readonly tick: number
	readonly sizedBy: Element
	visible = true
	private readonly ctx: CanvasRenderingContext2D
	private width = 0
	private height = 0

	constructor(
		readonly canvas: HTMLCanvasElement,
		private readonly palette: Palette,
		private readonly model: CardModel,
	) {
		this.tick = model.tick
		this.sizedBy = canvas
		this.ctx = context2d(canvas)
	}

	resize(force = false): void {
		const box = this.canvas.getBoundingClientRect()
		const width = Math.round(box.width)
		const height = Math.round(box.height)
		if (!width || !height || (!force && width === this.width && height === this.height)) return
		this.width = width
		this.height = height
		// Text is drawn at device resolution; past 2× the extra pixels buy nothing at these sizes.
		const scale = Math.min(2, window.devicePixelRatio || 1)
		this.canvas.width = Math.round(width * scale)
		this.canvas.height = Math.round(height * scale)
		this.ctx.setTransform(scale, 0, 0, scale, 0, 0)
		this.ctx.imageSmoothingEnabled = false
		this.model.layout(width, height, (text, font) => {
			this.ctx.font = font
			return this.ctx.measureText(text).width
		})
		this.draw()
	}

	step(): void {
		this.model.step()
	}

	draw(): void {
		if (!this.width) return
		this.ctx.fillStyle = this.palette.panel
		this.ctx.fillRect(0, 0, this.width, this.height)
		this.model.draw(this.ctx, this.palette)
	}
}
