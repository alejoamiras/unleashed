import { describe, expect, test } from "vitest"
import { BAYER4, CELL_PX, cellKind, fieldValue, initialField, paintField, type Rgb, stepField } from "./dither-field.ts"

const COLORS: readonly [Rgb, Rgb, Rgb] = [
	[0, 0, 0],
	[1, 1, 1],
	[2, 2, 2],
]

function paint(cols: number, rows: number, state = initialField()): Uint8ClampedArray {
	const out = new Uint8ClampedArray(cols * rows * 4)
	paintField(out, { cols, rows, width: cols * CELL_PX }, state, COLORS)
	return out
}

describe("dither field", () => {
	test("the Bayer matrix is a permutation of 0 to 15", () => {
		expect([...BAYER4].sort((a, b) => a - b)).toEqual([...Array(16).keys()])
	})

	test("the hoisted painter matches the field function cell by cell", () => {
		const state = { ...initialField(), heat: 0.8, hx: 40, hy: 30 }
		const cols = 40
		const out = paint(cols, 20, state)
		for (let r = 0; r < 20; r++) {
			for (let c = 0; c < cols; c++) {
				const want = cellKind(fieldValue(c * CELL_PX, r * CELL_PX, cols * CELL_PX, state), c, r)
				expect(out[(r * cols + c) * 4], `cell ${c},${r}`).toBe(want)
			}
		}
	})

	test("is the same frame for the same step, and moves on the next", () => {
		expect(paint(200, 100)).toEqual(paint(200, 100))
		const next = initialField()
		stepField(next)
		expect(paint(200, 100, next)).not.toEqual(paint(200, 100))
	})

	test("signal lives only in the band at the right edge, on desktop and phone widths", () => {
		for (const cols of [360, 98]) {
			const rows = 64
			const out = paint(cols, rows)
			const signalIn = (c: number) => [...Array(rows).keys()].filter((r) => out[(r * cols + c) * 4] === 2).length
			expect(signalIn(cols - 1), `${cols * CELL_PX} px, right edge`).toBeGreaterThan(0)
			for (let c = 0; c < cols / 2; c++) expect(signalIn(c), `${cols * CELL_PX} px, column ${c}`).toBe(0)
		}
	})

	test("the pointer trace decays to nothing", () => {
		const state = { ...initialField(), heat: 1 }
		for (let i = 0; i < 12; i++) stepField(state)
		expect(state.heat).toBe(0)
	})
})
