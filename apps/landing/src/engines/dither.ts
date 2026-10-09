import { CELL_PX, DITHER_TICK_MS, type FieldState, type Grid, initialField, paintField, stepField } from "./dither-field.ts"
import { context2d, type Engine, type Palette, rgb } from "./engine.ts"

/**
 * The page background. The canvas holds one pixel per cell and is scaled up 4× with
 * `image-rendering: pixelated`: its CSS size is set to whole cells, never 100%, because ceil(w/4)
 * cells stretched over w px would come out uneven.
 */
export class DitherField implements Engine {
	readonly tick = DITHER_TICK_MS
	readonly canvas: HTMLCanvasElement
	readonly sizedBy: Element
	// The host is the whole page, so only the tab's visibility or a pause stops it.
	visible = true
	private readonly ctx: CanvasRenderingContext2D
	private readonly state: FieldState = initialField()
	private grid: Grid = { cols: 0, rows: 0, width: 0 }
	private image: ImageData | null = null
	private height = 0

	constructor(
		private readonly host: HTMLElement,
		private readonly palette: Palette,
		private readonly tracing: () => boolean,
	) {
		this.sizedBy = host
		this.canvas = document.createElement("canvas")
		this.canvas.className = "bg"
		this.canvas.setAttribute("aria-hidden", "true")
		this.ctx = context2d(this.canvas)
		host.prepend(this.canvas)
		host.addEventListener("pointermove", (event) => this.trace(event))
	}

	resize(force = false): void {
		const box = this.host.getBoundingClientRect()
		const width = Math.round(box.width)
		const height = Math.round(box.height)
		if (!width || !height || (!force && width === this.grid.width && height === this.height)) return
		this.height = height
		this.grid = { cols: Math.ceil(width / CELL_PX), rows: Math.ceil(height / CELL_PX), width }
		this.canvas.width = this.grid.cols
		this.canvas.height = this.grid.rows
		this.canvas.style.width = `${this.grid.cols * CELL_PX}px`
		this.canvas.style.height = `${this.grid.rows * CELL_PX}px`
		this.image = this.ctx.createImageData(this.grid.cols, this.grid.rows)
		this.draw()
	}

	step(): void {
		stepField(this.state)
	}

	draw(): void {
		if (!this.image) return
		const { bg, line, signal } = this.palette
		paintField(this.image.data, this.grid, this.state, [rgb(bg), rgb(line), rgb(signal)])
		this.ctx.putImageData(this.image, 0, 0)
	}

	// A trace that follows the pointer is motion, so it only runs while the field does. Touch has no hover.
	private trace(event: PointerEvent): void {
		if (event.pointerType === "touch" || !this.tracing()) return
		const box = this.host.getBoundingClientRect()
		this.state.hx = event.clientX - box.left
		this.state.hy = event.clientY - box.top
		this.state.heat = 1
	}
}
