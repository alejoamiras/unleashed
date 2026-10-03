/// <reference types="node" />
import { readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * WCAG contrast for named token pairs in base.css. It resolves token references (token → token →
 * literal) with the theme block over `:root`; it is not a cascade resolver, so it covers only the
 * pairs a test names.
 */

export type Rgba = { r: number; g: number; b: number; a: number }
export type Theme = "light" | "dark"

const BASE_CSS_PATH = join(process.cwd(), "src/base.css")

/**
 * The `--name: value;` declarations of every rule whose selector list names `selector` exactly, in
 * source order. base.css has no nested blocks, which is what makes a flat rule scan sound.
 */
function parseBlock(css: string, selector: string): Record<string, string> {
	const out: Record<string, string> = {}
	for (const rule of css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
		if (!rule[1].split(",").some((s) => s.trim() === selector)) continue
		for (const m of rule[2].matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) out[m[1]] = m[2].trim()
	}
	return out
}

/** The effective token map for a theme: `:root` defaults overridden by the theme's block. */
export function themeMap(theme: Theme, css = readFileSync(BASE_CSS_PATH, "utf8")): Record<string, string> {
	const root = parseBlock(css, ":root")
	const themed = parseBlock(css, `[theme="${theme}"]`)
	return { ...root, ...themed }
}

const HEX = /^#([0-9a-f]{3,8})$/i
const RGB = /^rgba?\(([^)]+)\)$/i
const COLOR_MIX = /^color-mix\(\s*in\s+srgb\s*,\s*(.+?)\s+([\d.]+)%\s*,\s*transparent\s*\)$/i

function parseHex(hex: string): Rgba {
	let h = hex.slice(1)
	if (h.length === 3) h = [...h].map((c) => c + c).join("")
	if (h.length === 4) h = [...h].map((c) => c + c).join("")
	const n = (i: number) => Number.parseInt(h.slice(i, i + 2), 16)
	return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 }
}

function parseRgb(str: string): Rgba {
	const parts = str
		.replace(RGB, "$1")
		// Tolerate both comma syntax `rgb(1, 2, 3)` and CSS Color 4 space syntax `rgb(1 2 3 / 95%)`.
		.split(/[,/\s]+/)
		.map((s) => s.trim())
		.filter(Boolean)
	const chan = (s: string) => (s.endsWith("%") ? Math.round((Number.parseFloat(s) / 100) * 255) : Number.parseFloat(s))
	const alpha = (s?: string) => (s == null ? 1 : s.endsWith("%") ? Number.parseFloat(s) / 100 : Number.parseFloat(s))
	return { r: chan(parts[0]), g: chan(parts[1]), b: chan(parts[2]), a: alpha(parts[3]) }
}

/**
 * Resolve a token NAME (or raw value) to an Rgba for the given theme, following `var(--x, fallback)`
 * chains, `color-mix(in srgb, C P%, transparent)` (≡ C at P% alpha),
 * hex, and rgb/rgba. Cycle-guarded. Throws on a genuinely unresolvable reference (a ghost token).
 */
export function resolveColor(token: string, map: Record<string, string>, seen = new Set<string>()): Rgba {
	let value = token.startsWith("--") ? map[token] : token
	if (value == null) throw new Error(`unresolved token: ${token}`)
	value = value.trim()

	const mix = value.match(COLOR_MIX)
	if (mix) {
		const base = resolveColor(mix[1].trim(), map, seen)
		return { ...base, a: base.a * (Number.parseFloat(mix[2]) / 100) }
	}

	const varMatch = value.match(/^var\(\s*(--[a-z0-9-]+)\s*(?:,\s*(.+))?\)$/i)
	if (varMatch) {
		const name = varMatch[1]
		if (seen.has(name)) throw new Error(`var cycle at ${name}`)
		seen.add(name)
		if (map[name] != null) return resolveColor(name, map, seen)
		if (varMatch[2] != null) return resolveColor(varMatch[2].trim(), map, seen)
		throw new Error(`undefined var with no fallback: ${name}`)
	}

	if (HEX.test(value)) return parseHex(value)
	if (RGB.test(value)) return parseRgb(value)
	throw new Error(`uncolor value for ${token}: "${value}"`)
}

/** Composite a (possibly translucent) foreground over an opaque background → opaque Rgba. */
export function flatten(fg: Rgba, bg: Rgba): Rgba {
	const a = fg.a
	return {
		r: Math.round(fg.r * a + bg.r * (1 - a)),
		g: Math.round(fg.g * a + bg.g * (1 - a)),
		b: Math.round(fg.b * a + bg.b * (1 - a)),
		a: 1,
	}
}

function relativeLuminance({ r, g, b }: Rgba): number {
	const lin = (c: number) => {
		const s = c / 255
		return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
	}
	return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

/** WCAG 2.x contrast ratio between two colors. Foreground alpha is flattened over the background. */
export function contrast(fgToken: string, bgToken: string, theme: Theme, css = readFileSync(BASE_CSS_PATH, "utf8")): number {
	const map = themeMap(theme, css)
	const bg = resolveColor(bgToken, map)
	if (bg.a !== 1) throw new Error(`background ${bgToken} must be opaque for a contrast check`)
	const fg = flatten(resolveColor(fgToken, map), bg)
	const l1 = relativeLuminance(fg)
	const l2 = relativeLuminance(bg)
	const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1]
	return (hi + 0.05) / (lo + 0.05)
}
