/// <reference types="node" />
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "vitest"
import { themeMap } from "./theme-contrast"

const css = readFileSync(join(process.cwd(), "src/base.css"), "utf8")
const tokens = themeMap("dark")

/** The stepped 20-point polygon for notch `n`, step `n/2`, clockwise from the top-left edge. */
function notch(n: number): string {
	const N = `${n}px`
	const S = `${n / 2}px`
	const far = (v: string) => `calc(100% - ${v})`
	const points = [
		[N, "0"],
		[far(N), "0"],
		[far(N), S],
		[far(S), S],
		[far(S), N],
		["100%", N],
		["100%", far(N)],
		[far(S), far(N)],
		[far(S), far(S)],
		[far(N), far(S)],
		[far(N), "100%"],
		[N, "100%"],
		[N, far(S)],
		[S, far(S)],
		[S, far(N)],
		["0", far(N)],
		["0", N],
		[S, N],
		[S, S],
		[N, S],
	]
	return `polygon(${points.map((p) => p.join(" ")).join(", ")})`
}

const flat = (value: string) => value.replace(/\s+/g, " ").replace(/\( | \)/g, (m) => m.trim())

describe("base.css primitives", () => {
	test.each([2, 4, 6])("--ul-notch-%i is the stepped polygon", (n) => {
		expect(flat(tokens[`--ul-notch-${n}`])).toBe(notch(n))
	})

	test("--ul-notch-4-bottom is square on top and steps like --ul-notch-4 below", () => {
		const bottom = notch(4).slice("polygon(".length, -1).split(", ").slice(6, 16)
		expect(flat(tokens["--ul-notch-4-bottom"])).toBe(`polygon(${["0 0", "100% 0", ...bottom].join(", ")})`)
	})

	test("--ul-static is a self-contained SVG: nothing it could fetch", () => {
		const uri = tokens["--ul-static"].match(/^url\("data:image\/svg\+xml,(.+)"\)$/)?.[1]
		expect(uri).toBeDefined()
		const svg = decodeURIComponent(uri ?? "")
		expect(svg).toContain("feTurbulence type='fractalNoise' baseFrequency='0.92' numOctaves='1'")
		expect(svg).toContain("<filter id='s' color-interpolation-filters='sRGB'>")
		for (const channel of ["R", "G"]) {
			expect(svg).toContain(`feFunc${channel} type='discrete' tableValues='0.04 0.2 0.55 0.93'`)
		}
		expect(svg).toContain("feFuncB type='discrete' tableValues='0.05 0.22 0.56 0.92'")
		expect(svg.replace("xmlns='http://www.w3.org/2000/svg'", "")).not.toMatch(/https?:|href|@import|url\((?!#)/i)
	})

	test("reduced motion sends every animation and transition to its end frame", () => {
		const block = css.match(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/)?.[1] ?? ""
		expect(block).toMatch(/\*,\s*\*::before,\s*\*::after/)
		for (const decl of [
			"animation-duration: 0.01ms !important",
			"animation-delay: 0s !important",
			"animation-iteration-count: 1 !important",
			"animation-fill-mode: both !important",
			"transition-duration: 0.01ms !important",
			"transition-delay: 0s !important",
		]) {
			expect(block).toContain(decl)
		}
	})
})
