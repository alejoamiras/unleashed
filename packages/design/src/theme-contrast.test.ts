import { describe, expect, test } from "vitest"
import { contrast, resolveColor, themeMap } from "./theme-contrast"

/** WCAG AA: 4.5:1 for text, 3:1 for a non-text indicator such as a focus ring. */
const AA_TEXT = 4.5
const AA_NON_TEXT = 3

type Pair = { fg: string; bg: string }
const on = (fgs: string[], bgs: string[]): Pair[] => fgs.flatMap((fg) => bgs.map((bg) => ({ fg, bg })))

const FILLS = ["--ul-bg", "--ul-panel", "--ul-raised", "--ul-well", "--ul-field", "--ul-track"]
const STATUS = ["carrier", "attention", "lost", "other"]

/**
 * Each pair is a foreground a component may place on that background; a pair absent here is not a
 * permitted combination (e.g. `--ul-signal` as text: it is a fill).
 */
const TEXT_PAIRS: Pair[] = [
	...on(["--ul-ink", "--ul-ink-2", "--ul-ink-3"], FILLS),
	...on(["--ul-accent-text"], ["--ul-bg", "--ul-panel", "--ul-raised", "--ul-signal-tint"]),
	{ fg: "--ul-ink-caption", bg: "--ul-raised" },
	{ fg: "--ul-on-signal", bg: "--ul-signal" },
	{ fg: "--ul-ink", bg: "--ul-signal-tint" },
	{ fg: "--ul-ink", bg: "--ul-line" },
	{ fg: "--ul-ink-2", bg: "--ul-line" },
	{ fg: "--ul-line", bg: "--ul-ink" },
	...STATUS.map((s) => ({ fg: `--ul-${s}`, bg: `--ul-${s}-bg` })),
	...on(
		STATUS.map((s) => `--ul-${s}`),
		["--ul-bg", "--ul-panel", "--ul-raised"],
	),
]

for (const theme of ["dark", "light"] as const) {
	describe(`${theme} theme`, () => {
		for (const { fg, bg } of TEXT_PAIRS) {
			test(`${fg} on ${bg} >= ${AA_TEXT}:1`, () => {
				expect(contrast(fg, bg, theme)).toBeGreaterThanOrEqual(AA_TEXT)
			})
		}
		for (const ring of ["--ul-focus", "--ul-ring"]) {
			for (const bg of ["--ul-bg", "--ul-panel", "--ul-raised"]) {
				test(`${ring} on ${bg} >= ${AA_NON_TEXT}:1`, () => {
					expect(contrast(ring, bg, theme)).toBeGreaterThanOrEqual(AA_NON_TEXT)
				})
			}
		}
		test(`an inset ring on a reverse-video pick (--ul-bg on --ul-ink) >= ${AA_NON_TEXT}:1`, () => {
			expect(contrast("--ul-bg", "--ul-ink", theme)).toBeGreaterThanOrEqual(AA_NON_TEXT)
		})
	})
}

describe("themeMap", () => {
	test("light overrides the root values, and dark keeps them", () => {
		expect(resolveColor("--ul-panel", themeMap("light")).r).toBe(251)
		expect(resolveColor("--ul-panel", themeMap("dark")).r).toBeLessThan(40)
	})

	test("a token reference follows the theme of the token it names", () => {
		expect(resolveColor("--ul-on-signal", themeMap("light"))).toEqual(resolveColor("--ul-ink", themeMap("light")))
		expect(resolveColor("--ul-on-signal", themeMap("dark"))).toEqual(resolveColor("--ul-bg", themeMap("dark")))
	})

	test("a selector matches only as a whole entry of a selector list", () => {
		const css = `.x [theme="light"] { --a: #fff; }\n:root, [theme="dark"] { --a: #000; }`
		expect(themeMap("light", css)["--a"]).toBe("#000")
		expect(themeMap("dark", css)["--a"]).toBe("#000")
	})
})

describe("resolveColor", () => {
	test("parses hex, comma rgba and space-separated rgb", () => {
		expect(resolveColor("#1f5bb8", {})).toEqual({ r: 31, g: 91, b: 184, a: 1 })
		expect(resolveColor("rgba(124, 116, 104, 0.3)", {})).toEqual({ r: 124, g: 116, b: 104, a: 0.3 })
		expect(resolveColor("rgb(255 255 255 / 50%)", {})).toEqual({ r: 255, g: 255, b: 255, a: 0.5 })
	})
})
