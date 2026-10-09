/** Canvas helpers the card screens share, in the board's pixel grammar: 2 px dots, 2 px notches. */
import type { Palette } from "./engine.ts"

export const BODY_FONT = '"Atkinson Hyperlegible Next", system-ui, sans-serif'
export const MONO_FONT = '"Atkinson Hyperlegible Mono", ui-monospace, monospace'

export const snap = (value: number, grid: number) => Math.round(value / grid) * grid

/** A rectangle with stepped corners `n` px deep, as `--ul-notch-*` draws them. */
export function notchPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, n: number): void {
	const s = n / 2
	const points = [
		[n, 0],
		[w - n, 0],
		[w - n, s],
		[w - s, s],
		[w - s, n],
		[w, n],
		[w, h - n],
		[w - s, h - n],
		[w - s, h - s],
		[w - n, h - s],
		[w - n, h],
		[n, h],
		[n, h - s],
		[s, h - s],
		[s, h - n],
		[0, h - n],
		[0, n],
		[s, n],
		[s, s],
		[n, s],
	]
	const [[startX, startY], ...rest] = points
	ctx.beginPath()
	ctx.moveTo(x + startX, y + startY)
	for (const [px, py] of rest) ctx.lineTo(x + px, y + py)
	ctx.closePath()
}

/** A pixel icon's paths (24-unit viewBox) at `size` px. */
export function drawIcon(ctx: CanvasRenderingContext2D, paths: readonly string[], x: number, y: number, size: number, color: string): void {
	ctx.save()
	ctx.translate(x, y)
	ctx.scale(size / 24, size / 24)
	ctx.fillStyle = color
	for (const d of paths) ctx.fill(new Path2D(d))
	ctx.restore()
}

export function laneDots(ctx: CanvasRenderingContext2D, palette: Palette, y: number, x0: number, x1: number): void {
	ctx.fillStyle = palette.line
	for (let x = snap(x0, 8); x < x1; x += 8) ctx.fillRect(x, y, 2, 2)
}

export function dotGrid(ctx: CanvasRenderingContext2D, color: string, w: number, h: number): void {
	ctx.fillStyle = color
	for (let y = 5; y < h; y += 8) for (let x = 5; x < w; x += 8) ctx.fillRect(x, y, 2, 2)
}

export function caption(
	ctx: CanvasRenderingContext2D,
	palette: Palette,
	text: string,
	x: number,
	y: number,
	align: CanvasTextAlign = "start",
): void {
	ctx.font = `700 10px ${BODY_FONT}`
	ctx.textBaseline = "middle"
	ctx.textAlign = align
	ctx.fillStyle = palette.ink3
	ctx.fillText(text, x, y)
	ctx.textAlign = "start"
}

// The four grey levels of `--ul-static`: fixed in both themes, because static means "encrypted", not a colour.
const STATIC_LEVELS = [
	[10, 10, 13],
	[51, 51, 56],
	[140, 140, 143],
	[237, 237, 235],
] as const

/** Static for a veiled amount: a small tile reshuffled each step and stretched over the veiled part. */
export class StaticNoise {
	static readonly WIDTH = 96
	static readonly HEIGHT = 8
	readonly canvas: HTMLCanvasElement
	private readonly ctx: CanvasRenderingContext2D
	private readonly image: ImageData

	constructor(private readonly rand: () => number) {
		this.canvas = document.createElement("canvas")
		this.canvas.width = StaticNoise.WIDTH
		this.canvas.height = StaticNoise.HEIGHT
		const ctx = this.canvas.getContext("2d")
		if (!ctx) throw new Error("no 2D canvas context")
		this.ctx = ctx
		this.image = ctx.createImageData(StaticNoise.WIDTH, StaticNoise.HEIGHT)
		this.shuffle()
	}

	shuffle(): void {
		const data = this.image.data
		for (let i = 0; i < data.length; i += 4) {
			const level = STATIC_LEVELS[Math.floor(this.rand() * STATIC_LEVELS.length)]
			data[i] = level[0]
			data[i + 1] = level[1]
			data[i + 2] = level[2]
			data[i + 3] = 242
		}
		this.ctx.putImageData(this.image, 0, 0)
	}
}
