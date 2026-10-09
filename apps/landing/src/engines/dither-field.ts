/**
 * The Dither tide's field, as on the landing board: two slow interference waves plus a band that
 * rises toward the right edge, ordered-dithered through a 4×4 Bayer matrix into background, line and
 * signal cells. Pure, so the hot loop is testable and runs without a DOM.
 */

export const CELL_PX = 4
export const DITHER_TICK_MS = 150

export const BAYER4: readonly number[] = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]

const TRACE_RADIUS = 110
const TRACE_GAIN = 0.6
const TRACE_DECAY = 0.7

export interface FieldState {
	/** Steps since start; the board starts at 40 so the first frame is mid-swell. */
	t: number
	/** Pointer trace strength, 1 on a move and decaying each step. */
	heat: number
	hx: number
	hy: number
}

export const initialField = (): FieldState => ({ t: 40, heat: 0, hx: -1e4, hy: -1e4 })

export function stepField(state: FieldState): void {
	state.t++
	state.heat = state.heat > 0.1 ? state.heat * TRACE_DECAY : 0
}

/** Where the signal band starts rising: near the right edge on phones, past the middle elsewhere. */
export function bandStart(width: number): number {
	return width < 640 ? width - 72 : width * 0.56
}

function band(x: number, width: number): number {
	const start = bandStart(width)
	return x < start ? 0 : ((x - start) / Math.max(1, width - start)) ** 1.5 * 1.08
}

function trace(x: number, y: number, state: FieldState): number {
	if (!state.heat) return 0
	const dx = x - state.hx
	const dy = y - state.hy
	if (dx > TRACE_RADIUS || dx < -TRACE_RADIUS || dy > TRACE_RADIUS || dy < -TRACE_RADIUS) return 0
	const distance = Math.sqrt(dx * dx + dy * dy)
	return distance < TRACE_RADIUS ? state.heat * TRACE_GAIN * (1 - distance / TRACE_RADIUS) : 0
}

// The diagonal wave sin((0.6x + y)·0.009 + 1.3φ), split by angle addition into a column part and a row
// part so the painter needs no sine per cell. fieldValue computes the same expression, term for term.
const diagX = (x: number) => x * 0.0054
const diagY = (y: number, phase: number) => y * 0.009 + phase * 1.3

/** The field at a point, in CSS px. Above 1 is signal. */
export function fieldValue(x: number, y: number, width: number, state: FieldState): number {
	const phase = state.t * 0.07
	const diag = Math.sin(diagX(x)) * Math.cos(diagY(y, phase)) + Math.cos(diagX(x)) * Math.sin(diagY(y, phase))
	return 0.1 + 0.12 * Math.sin(x * 0.011 + phase) * Math.sin(y * 0.017 - phase * 0.7) + 0.08 * diag + band(x, width) + trace(x, y, state)
}

/** 0 background, 1 line, 2 signal. */
export function cellKind(value: number, col: number, row: number): 0 | 1 | 2 {
	if (value <= (BAYER4[(row & 3) * 4 + (col & 3)] + 0.5) / 16) return 0
	return value > 1 ? 2 : 1
}

export type Rgb = readonly [number, number, number]

export interface Grid {
	readonly cols: number
	readonly rows: number
	/** The host's width in CSS px, which places the band. */
	readonly width: number
}

interface Columns {
	readonly wave: Float64Array
	readonly diagSin: Float64Array
	readonly diagCos: Float64Array
	readonly band: Float64Array
}

function columnTerms(grid: Grid, phase: number): Columns {
	const terms = {
		wave: new Float64Array(grid.cols),
		diagSin: new Float64Array(grid.cols),
		diagCos: new Float64Array(grid.cols),
		band: new Float64Array(grid.cols),
	}
	for (let c = 0; c < grid.cols; c++) {
		const x = c * CELL_PX
		terms.wave[c] = Math.sin(x * 0.011 + phase)
		terms.diagSin[c] = Math.sin(diagX(x))
		terms.diagCos[c] = Math.cos(diagX(x))
		terms.band[c] = band(x, grid.width)
	}
	return terms
}

/**
 * Writes one RGBA pixel per cell, the same values fieldValue gives. Every sine is hoisted to a column
 * or a row, and colours are read by index: the inner loop runs once per cell, every 150 ms.
 */
export function paintField(out: Uint8ClampedArray, grid: Grid, state: FieldState, colors: readonly [Rgb, Rgb, Rgb]): void {
	const phase = state.t * 0.07
	const cols = columnTerms(grid, phase)
	for (let r = 0; r < grid.rows; r++) {
		const y = r * CELL_PX
		const rowWave = Math.sin(y * 0.017 - phase * 0.7)
		const rowSin = Math.sin(diagY(y, phase))
		const rowCos = Math.cos(diagY(y, phase))
		for (let c = 0; c < grid.cols; c++) {
			const diag = cols.diagSin[c] * rowCos + cols.diagCos[c] * rowSin
			const value = 0.1 + 0.12 * cols.wave[c] * rowWave + 0.08 * diag + cols.band[c] + trace(c * CELL_PX, y, state)
			const color = colors[cellKind(value, c, r)]
			const i = (r * grid.cols + c) * 4
			out[i] = color[0]
			out[i + 1] = color[1]
			out[i + 2] = color[2]
			out[i + 3] = 255
		}
	}
}
