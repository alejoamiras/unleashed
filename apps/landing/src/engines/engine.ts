/** Something the page's one loop steps: the background field or a card's screen. */
export interface Engine {
	/** Milliseconds per step. */
	readonly tick: number
	readonly canvas: HTMLCanvasElement
	/** The element whose size the engine follows; the page observes it and calls `resize`. */
	readonly sizedBy: Element
	/** Whether the canvas is on screen; the loop skips an engine that is not. */
	visible: boolean
	/** Re-measures the canvas; on a new size (or `force`) lays out again and draws. */
	resize(force?: boolean): void
	step(): void
	draw(): void
}

/** The theme's colours, read from the `--ul-*` tokens. One shared object, refreshed in place on a theme change. */
export interface Palette {
	bg: string
	panel: string
	raised: string
	line: string
	ink: string
	ink2: string
	ink3: string
	signal: string
	carrier: string
}

const TOKENS: Readonly<Record<keyof Palette, string>> = {
	bg: "--ul-bg",
	panel: "--ul-panel",
	raised: "--ul-raised",
	line: "--ul-line",
	ink: "--ul-ink",
	ink2: "--ul-ink-2",
	ink3: "--ul-ink-3",
	signal: "--ul-signal",
	carrier: "--ul-carrier",
}

export function readPalette(style: CSSStyleDeclaration, into: Partial<Palette> = {}): Palette {
	for (const [key, token] of Object.entries(TOKENS) as [keyof Palette, string][]) {
		into[key] = style.getPropertyValue(token).trim() || "#888888"
	}
	return into as Palette
}

/** `#rgb` or `#rrggbb` to channels; the tokens are all hex. */
export function rgb(hex: string): [number, number, number] {
	let digits = hex.replace("#", "")
	if (digits.length === 3) digits = [...digits].map((d) => d + d).join("")
	const n = Number.parseInt(digits, 16)
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** A 2D context, or a thrown error the page turns into a missing screen. */
export function context2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
	const ctx = canvas.getContext("2d")
	if (!ctx) throw new Error("no 2D canvas context")
	return ctx
}
