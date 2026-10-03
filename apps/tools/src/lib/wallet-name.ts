/** Controls, format characters (bidi marks, overrides and isolates, zero-width characters, the soft
 *  hyphen, the BOM, tag characters), lone surrogates, line and paragraph separators, and the
 *  characters that render blank: the combining grapheme joiner, the Hangul fillers and the braille
 *  blank. */
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}\u115f\u1160\u2800\u3164\uffa0]|\u034f/gu
/** More than four combining marks on one base is a stacking attack, not a script. */
const MARK_RUN = /(\p{M}{4})\p{M}+/gu
const SPACE_RUN = /\s+/gu
const VISIBLE = /[\p{L}\p{N}\p{P}\p{S}]/u

/** UTF-16 units of a claimed name read at all; the rest is cut before any other work. */
const INPUT_MAX = 1024
/** Output budget per kept grapheme, in UTF-16 units, so one grapheme cannot carry the whole input. */
const UNITS_PER_GRAPHEME = 8

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })

/** The default bound on a stored or displayed wallet name, in graphemes. */
export const WALLET_NAME_MAX = 48

/**
 * A wallet-claimed name (a provider's name or an account alias) bounded for storage and display:
 * invisible characters stripped, mark runs capped at four, whitespace collapsed, then at most `max`
 * graphemes and `max * 8` UTF-16 units, plus "…" when cut. Returns "" when no letter, digit,
 * punctuation or symbol is left. Idempotent for a given `max`. The result is still untrusted text:
 * render it through text interpolation only.
 */
export function sanitizeWalletName(raw: string, max: number = WALLET_NAME_MAX): string {
	const clean = raw.slice(0, INPUT_MAX).replace(INVISIBLE, "").replace(MARK_RUN, "$1").replace(SPACE_RUN, " ").trim()
	if (!VISIBLE.test(clean)) return ""
	const budget = max * UNITS_PER_GRAPHEME
	let out = ""
	let kept = 0
	for (const { segment } of graphemes.segment(clean)) {
		if (kept === max || out.length + segment.length > budget) return `${out.trimEnd()}…`
		out += segment
		kept++
	}
	return out
}

const KNOWN_TYPES: ReadonlyMap<string, "Extension" | "Web app"> = new Map([
	["extension", "Extension"],
	["web", "Web app"],
])
const TYPE_TITLE_MAX = 16

/**
 * The picker chip for a wallet-claimed provider type. Only the two types wallet-sdk defines get a
 * label; any other claim reads "Unknown type" and its sanitized text appears only in `title`, so a
 * wallet cannot print its own badge ("Verified wallet") in the chip.
 */
export function walletTypeLabel(type: unknown): { label: "Extension" | "Web app" | "Unknown type"; title?: string } {
	if (typeof type !== "string") return { label: "Unknown type" }
	const known = KNOWN_TYPES.get(type)
	if (known) return { label: known }
	const claim = sanitizeWalletName(type, TYPE_TITLE_MAX)
	return claim ? { label: "Unknown type", title: `Self-reported: ${claim}` } : { label: "Unknown type" }
}

/** UTF-16 units of the claimed id read at each end; a window this size is never cut by the sanitizer. */
const ID_WINDOW = 64
const ID_HEAD = 4
const ID_TAIL = 4

function visibleGraphemes(window: string): string[] {
	return Array.from(graphemes.segment(sanitizeWalletName(window, ID_WINDOW)), (s) => s.segment)
}

/** The picker's id line, `id 7c1e…a4f0`: a short id whole, a longer one as its first and last four
 *  graphemes, each end sanitized from its own window of the raw id so the tail is the id's real end.
 *  `null` when nothing visible is left. */
export function walletIdLine(id: string): string | null {
	const head = visibleGraphemes(id.slice(0, ID_WINDOW))
	const tail = id.length > ID_WINDOW ? visibleGraphemes(id.slice(-ID_WINDOW)) : head
	if (head.length === 0 && tail.length === 0) return null
	if (id.length <= ID_WINDOW && head.length <= ID_HEAD + ID_TAIL + 1) return `id ${head.join("")}`
	return `id ${head.slice(0, ID_HEAD).join("")}…${tail.slice(-ID_TAIL).join("")}`
}

/** Up to three words of letters, digits and name punctuation: no URL, no sentence punctuation. */
const NAME_LIKE = /^[\p{L}\p{N}][\p{L}\p{M}\p{N}'’-]*(?: [\p{L}\p{N}][\p{L}\p{M}\p{N}'’-]*){0,2}$/u
const LABEL_MAX = 24

/** How the app's own sentences name the user's wallet: `the wallet “{name}”` when its sanitized
 *  name is short and name-shaped, else "your wallet". The quotes mark the claimed text as a name,
 *  since three plain words can still read as an instruction ("your recovery phrase"). */
export function walletLabel(name: string | null): string {
	const clean = name === null ? "" : sanitizeWalletName(name, LABEL_MAX)
	return NAME_LIKE.test(clean) ? `the wallet “${clean}”` : "your wallet"
}
