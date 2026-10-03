import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"

/**
 * The two rules that carry an accepted-suppression baseline. The nested-test-suites
 * rule is deliberately absent: it had zero findings at adoption and must stay clean.
 */
export const BASELINED_RULES = ["noExcessiveCognitiveComplexity", "noExcessiveLinesPerFunction"] as const
export type BaselinedRule = (typeof BASELINED_RULES)[number]

const BUDGET_RULES = new Set<string>([...BASELINED_RULES, "noExcessiveNestedTestSuites"])

/**
 * Detects every Biome suppression form that could reach a budget rule, ANYWHERE on a line:
 * single-line, file-wide (-all) and range (-start/-end) variants, flexible whitespace, and the
 * bare `lint:` / group `lint/complexity:` scopes that suppress budget rules implicitly.
 */
const SUPPRESSION_RE = /biome-ignore(-all|-start|-end)?\s+lint(?:\/([A-Za-z0-9]+))?(?:\/([A-Za-z0-9]+))?\s*:/

/**
 * The ONLY legal form for a budget-rule suppression: a whole `//` comment line whose reason is
 * `accepted at score N — <sentence>` (cognitive) or `accepted at N lines — <sentence>` (length).
 * The stamp is the function's exact observed value (the rescore audit holds it to that); the
 * sentence is why the complexity is essential at that site — the check here is syntactic
 * (length, no placeholder words); specificity stays review-enforced.
 */
const ACCEPTED_RE =
	/^\s*\/\/\s*biome-ignore\s+lint\/complexity\/(noExcessiveCognitiveComplexity|noExcessiveLinesPerFunction)\s*:\s*accepted at (?:score (\d+)|(\d+) lines) — (.+?)\s*$/
const MIN_SENTENCE = 12
const PLACEHOLDER_RE = /\b(?:todo|tbd|fixme|xxx|placeholder)\b/i
/** The generator's fail-closed marker for a function a Biome bump newly flags. */
export const MARKER_PREFIX = "JUSTIFICATION REQUIRED"
export const UNSCORED_PREFIX = "baseline ("

export type Classified =
	| { kind: "baselined"; rule: BaselinedRule; accepted: number; sentence: string }
	| { kind: "forbidden"; why: string }
	| null

/**
 * Classifies one source line's suppression comment against the budget policy.
 * Returns null for suppressions that cannot affect a budget rule.
 */
export function classifySuppressionLine(line: string): Classified {
	const m = line.match(SUPPRESSION_RE)
	if (!m) return null
	const [, variant, group, rule] = m
	const reachesBudget = group === undefined || (group === "complexity" && (rule === undefined || BUDGET_RULES.has(rule)))
	if (!reachesBudget) return null
	if (variant !== undefined) {
		return { kind: "forbidden", why: `file-wide/range suppression (biome-ignore${variant}) covering complexity budgets` }
	}
	if (group === undefined) {
		return { kind: "forbidden", why: "bare `lint` suppression — suppresses every rule incl. complexity budgets; scope it to one rule" }
	}
	if (rule === undefined) {
		return { kind: "forbidden", why: "group-level `lint/complexity` suppression — scope it to one rule" }
	}
	if (rule === "noExcessiveNestedTestSuites") {
		return { kind: "forbidden", why: "noExcessiveNestedTestSuites had zero findings at adoption — restructure, never suppress" }
	}
	return classifyAcceptedForm(line, rule as BaselinedRule)
}

function classifyAcceptedForm(line: string, rule: BaselinedRule): Classified {
	const reason = line.slice(line.indexOf(":") + 1).trim()
	if (reason.startsWith(UNSCORED_PREFIX)) {
		return { kind: "forbidden", why: "`baseline (…)` text carries no score — replace with `accepted at score N — <why>` (or `N lines`) or refactor" }
	}
	if (reason.startsWith(MARKER_PREFIX)) {
		return { kind: "forbidden", why: "generator marker — a human must justify (`accepted at … — <why>`) or refactor this function" }
	}
	const m = line.match(ACCEPTED_RE)
	if (!m) {
		return { kind: "forbidden", why: "reason must be a whole `//` comment reading `accepted at score N — <one specific sentence>` (or `accepted at N lines — …`)" }
	}
	const [, matchedRule, score, lines, sentence] = m
	if (matchedRule !== rule) return { kind: "forbidden", why: "suppression rule and accepted form disagree" }
	const unitIsScore = score !== undefined
	if (unitIsScore !== (rule === "noExcessiveCognitiveComplexity")) {
		return { kind: "forbidden", why: `${rule} takes \`accepted at ${rule === "noExcessiveCognitiveComplexity" ? "score N" : "N lines"} — …\`` }
	}
	if (sentence.length < MIN_SENTENCE || PLACEHOLDER_RE.test(sentence)) {
		return { kind: "forbidden", why: "the accepted sentence must say why THIS function's complexity is essential (no placeholders)" }
	}
	return { kind: "baselined", rule, accepted: Number(score ?? lines), sentence }
}

/**
 * Lintable-source pathspecs. `*.d.ts` is excluded to mirror Biome's scope — the
 * generated types headers carry sanctioned bare-lint suppressions Biome never reads.
 */
const SOURCE_PATHSPECS = [
	"*.ts",
	"*.mts",
	"*.cts",
	"*.tsx",
	"*.js",
	"*.mjs",
	"*.cjs",
	"*.jsx",
	"*.vue",
	":(exclude)*.d.ts",
]

/** The manifest's per-acceptance record. Identity is (file, rule, anchor) — `anchor` is the
 *  declaration line under the directive, which must be unique in its file — and the pinned
 *  claim is (accepted, sentence). A directive moved onto another function is a new identity. */
export interface ManifestEntry {
	file: string
	rule: BaselinedRule
	anchor: string
	accepted: number
	sentence: string
}

/** One accepted directive as the tree carries it: a manifest entry plus its source line. */
export interface AcceptedDirective extends ManifestEntry {
	line: number
}

export interface ScanResult {
	ruleCounts: Record<BaselinedRule, Record<string, number>>
	accepted: AcceptedDirective[]
	forbidden: { file: string; line: number; why: string }[]
}

/** How far below a directive the declaration may sit (paired directives, a doc comment, blanks). */
const ANCHOR_LOOKAHEAD = 8
/** Lines that cannot be the declaration: blank, line comments, block-comment openers and their
 *  star-prefixed continuation and closing lines (a `*gen() {` generator method is a declaration). */
const NON_DECLARATION_RE = /^\s*(?:\/\/|\/\*|\*(?:\s|\/|$)|$)/

/**
 * Scans tracked source for suppressions reaching budget rules. Default reads the
 * working tree; `staged: true` reads the index (`git grep --cached`) — what a commit
 * actually captures, so the pre-commit hook can't be split-staged past.
 */
export function scanTree(opts: { staged?: boolean } = {}): ScanResult {
	const staged = opts.staged === true
	const flags = staged ? ["--cached"] : []
	const res = spawnSync("git", ["grep", ...flags, "-nF", `-A${ANCHOR_LOOKAHEAD}`, "biome-ignore", "--", ...SOURCE_PATHSPECS], {
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
	})
	// git grep exits 1 on zero matches — only >1 is a real failure.
	if (res.status !== 0 && res.status !== 1) throw new Error(`git grep failed (${res.status}): ${res.stderr}`)
	const parsed = parseGrepWithContext(res.stdout)
	const accepted: AcceptedDirective[] = []
	const forbidden: ScanResult["forbidden"] = []
	for (const hit of parsed.matches) {
		const c = classifySuppressionLine(hit.content)
		if (c === null) continue
		if (c.kind === "forbidden") {
			forbidden.push({ file: hit.file, line: hit.line, why: c.why })
			continue
		}
		const anchor = anchorFor(parsed, hit.file, hit.line)
		if (anchor === undefined) {
			forbidden.push({ file: hit.file, line: hit.line, why: `no declaration within ${ANCHOR_LOOKAHEAD} lines below the directive — an acceptance sits directly above the function it covers` })
			continue
		}
		accepted.push({ file: hit.file, line: hit.line, rule: c.rule, accepted: c.accepted, sentence: c.sentence, anchor })
	}
	forbidden.push(...duplicateIdentities(accepted), ...ambiguousAnchors(accepted, staged))
	// Byte-order sorts — locale-independent so regeneration is reproducible across machines.
	accepted.sort(compareDirectives)
	forbidden.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line))
	return { ruleCounts: ruleCountsOf(accepted), accepted, forbidden }
}

interface GrepLine {
	file: string
	line: number
	content: string
}
export interface ParsedGrep {
	matches: GrepLine[]
	/** Every line git printed (matches and context), keyed `file:line`. */
	byKey: Map<string, string>
}

/** `git grep -n -A<N>` prints `file:line:content` for matches, `file-line-content` for context
 *  lines and `--` between groups; file names cannot contain `:` or `-` ambiguity because the
 *  line number is the first all-digit field after the last matching separator position. */
export function parseGrepWithContext(stdout: string): ParsedGrep {
	const matches: GrepLine[] = []
	const byKey = new Map<string, string>()
	for (const raw of stdout.split("\n")) {
		if (!raw || raw === "--") continue
		const m = raw.match(/^(.+?)([:-])(\d+)\2(.*)$/)
		if (!m) continue
		const [, file, sep, lineNo, content] = m
		const line = Number(lineNo)
		byKey.set(`${file}:${line}`, content)
		if (sep === ":") matches.push({ file, line, content })
	}
	return { matches, byKey }
}

/** The first line under the directive that is neither blank nor a comment (so neither a paired
 *  directive nor a doc block), trimmed — the declaration it applies to. */
export function anchorFor(parsed: ParsedGrep, file: string, line: number): string | undefined {
	for (let offset = 1; offset <= ANCHOR_LOOKAHEAD; offset++) {
		const next = parsed.byKey.get(`${file}:${line + offset}`)
		if (next === undefined) return undefined
		if (NON_DECLARATION_RE.test(next)) continue
		return next.trim()
	}
	return undefined
}

function duplicateIdentities(accepted: AcceptedDirective[]): ScanResult["forbidden"] {
	const first = new Map<string, number>()
	const out: ScanResult["forbidden"] = []
	for (const d of accepted) {
		const key = entryKey(d)
		const seenAt = first.get(key)
		if (seenAt === undefined) first.set(key, d.line)
		else out.push({ file: d.file, line: d.line, why: `duplicate acceptance — same rule and declaration as line ${seenAt}` })
	}
	return out
}

function fileLines(file: string, staged: boolean): string[] {
	if (!staged) return readFileSync(file, "utf8").split("\n")
	const res = spawnSync("git", ["show", `:${file}`], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
	if (res.status !== 0) throw new Error(`git show :${file} failed (${res.status}): ${res.stderr}`)
	return res.stdout.split("\n")
}

/** An anchor that occurs more than once in its file would let a directive slide onto a
 *  same-text declaration (a same-file swap) without changing identity — refused. */
export function ambiguousAnchors(accepted: AcceptedDirective[], staged = false): ScanResult["forbidden"] {
	const byFile = new Map<string, AcceptedDirective[]>()
	for (const d of accepted) byFile.set(d.file, [...(byFile.get(d.file) ?? []), d])
	const out: ScanResult["forbidden"] = []
	for (const [file, list] of byFile) {
		const trimmed = fileLines(file, staged).map((l) => l.trim())
		for (const d of list) {
			const n = trimmed.filter((l) => l === d.anchor).length
			if (n > 1) out.push({ file, line: d.line, why: `the declaration line under the directive occurs ${n}× in this file — an acceptance anchors to a unique declaration (name it, or move the directive onto the named one)` })
		}
	}
	return out
}

export function compareDirectives(a: AcceptedDirective, b: AcceptedDirective): number {
	const ka = entryKey(a)
	const kb = entryKey(b)
	return ka < kb ? -1 : ka > kb ? 1 : 0
}

export const entryKey = (e: ManifestEntry) => `${e.rule} ${e.file} — ${e.anchor}`

export interface BaselineManifest {
	biomeVersion: string
	/** Derived, readable summary — the ratchet's authority is `accepted`. */
	rules: Record<BaselinedRule, Record<string, number>>
	accepted: ManifestEntry[]
}

/** A manifest with per-rule counts and no entries: never written, and refused as the current shape. */
export interface CountsOnlyManifest {
	biomeVersion: string
	rules: Record<BaselinedRule, Record<string, number>>
	accepted?: undefined
}

export function hasEntries(m: BaselineManifest | CountsOnlyManifest): m is BaselineManifest {
	return Array.isArray(m.accepted)
}

export interface EntryDiff {
	/** In `head` with no identity in `base`, and not a move. */
	added: ManifestEntry[]
	/** In `base` with no identity in `head`, and not a move. */
	removed: ManifestEntry[]
	/** Same rule, stamp and sentence under a new identity: a renamed declaration or a moved file. */
	moved: { from: ManifestEntry; to: ManifestEntry }[]
	/** Same identity, different stamp. */
	restamped: { key: string; from: number; to: number }[]
	/** Same identity and stamp, different sentence. */
	reworded: string[]
}

/** Diffs two acceptance sets entry by entry. Used both for tree-vs-manifest (must be empty in
 *  every bucket) and manifest-vs-base-branch (the shrink-only ratchet, see `ratchetViolations`). */
export function diffEntries(base: ManifestEntry[], head: ManifestEntry[]): EntryDiff {
	const pinned = new Map(base.map((e) => [entryKey(e), e]))
	const seen = new Map(head.map((e) => [entryKey(e), e]))
	const added: ManifestEntry[] = []
	const restamped: EntryDiff["restamped"] = []
	const reworded: string[] = []
	for (const [key, e] of seen) {
		const was = pinned.get(key)
		if (!was) added.push(e)
		else if (was.accepted !== e.accepted) restamped.push({ key, from: was.accepted, to: e.accepted })
		else if (was.sentence !== e.sentence) reworded.push(key)
	}
	const removed = [...pinned].filter(([key]) => !seen.has(key)).map(([, e]) => e)
	return { ...pairMoves(added, removed), restamped, reworded }
}

const MODIFIERS = "public|private|protected|static|readonly|override|async|get|set"
/** Words the method pattern could otherwise read as a name (`if (`, `async (x) => {`, `return (`). */
const NOT_A_METHOD = `${MODIFIERS}|function|if|for|while|switch|catch|return|await|yield|typeof|void|delete|new|throw`
const NAME_PATTERNS: RegExp[] = [
	/^(?:describe|it|test)(?:\.\w+)*\(\s*(["'`])(.+?)\1/,
	/^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/,
	/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/,
	/^([A-Za-z_$][\w$]*)\s*:\s*(?:async\s*)?(?:\(|function\b)/,
	new RegExp(`^(?:(?:${MODIFIERS})\\s+)*\\*?\\s*(?!(?:${NOT_A_METHOD})\\b)([A-Za-z_$][\\w$]*)\\s*[(<]`),
]

/** The name a declaration line binds — a test title, a function, a `const` arrow, an object
 *  property, or a class/object method. Anonymous callbacks have none: they carry no move path
 *  (any edit to their line is a new identity), which fails closed. */
export function declarationName(anchor: string): string | undefined {
	for (const re of NAME_PATTERNS) {
		const m = anchor.match(re)
		if (m) return m[2] ?? m[1]
	}
	return undefined
}

/** Pairs an added entry with a removed one as a MOVE when the function's identity visibly
 *  continues — same rule, stamp, sentence and declaration name (a signature edit or a file move
 *  of a named declaration; anonymous callbacks have no move path). Name continuity is evidence
 *  for a reviewer, not proof: a same-named replacement with the same score and a copied sentence
 *  pairs too, which is why the CI ratchet refuses moves unless the PR carries the owner's
 *  `baseline:move-approved` label. */
function pairMoves(added: ManifestEntry[], removed: ManifestEntry[]): Pick<EntryDiff, "added" | "removed" | "moved"> {
	const pool = [...removed]
	const moved: EntryDiff["moved"] = []
	const unpaired: ManifestEntry[] = []
	for (const a of added) {
		const i = pool.findIndex((r) => isMoveOf(r, a))
		if (i === -1) unpaired.push(a)
		else moved.push({ from: pool.splice(i, 1)[0], to: a })
	}
	return { added: unpaired, removed: pool, moved }
}

function isMoveOf(from: ManifestEntry, to: ManifestEntry): boolean {
	if (from.rule !== to.rule || from.accepted !== to.accepted || from.sentence !== to.sentence) return false
	const name = declarationName(from.anchor)
	return name !== undefined && name === declarationName(to.anchor)
}

/** The PR label an owner applies to let a move (see `pairMoves`) through the CI ratchet. */
export const MOVE_APPROVED_LABEL = "baseline:move-approved"

/** What a change on the SAME Biome may never do to the acceptance set: add one, raise one, or —
 *  without the owner's label — move one. */
export function ratchetViolations(diff: EntryDiff, opts: { movesApproved?: boolean } = {}): string[] {
	const out = diff.added.map((e) => `+ ${entryKey(e)} (accepted at ${e.accepted})`)
	for (const r of diff.restamped) if (r.to > r.from) out.push(`↑ ${r.key}: ${r.from} → ${r.to}`)
	if (opts.movesApproved !== true) {
		for (const m of diff.moved) out.push(`→ ${entryKey(m.from)}  ⇒  ${entryKey(m.to)} (a move needs the \`${MOVE_APPROVED_LABEL}\` label on the PR)`)
	}
	return out
}

/** The manifest's `rules` summary, derived from the entries — the only form the checks trust. */
export function ruleCountsOf(entries: ManifestEntry[]): BaselineManifest["rules"] {
	const counts = Object.fromEntries(BASELINED_RULES.map((r) => [r, {} as Record<string, number>])) as BaselineManifest["rules"]
	for (const e of entries) counts[e.rule][e.file] = (counts[e.rule][e.file] ?? 0) + 1
	for (const rule of BASELINED_RULES) {
		counts[rule] = Object.fromEntries(Object.entries(counts[rule]).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
	}
	return counts
}

export function toManifestEntries(accepted: AcceptedDirective[]): ManifestEntry[] {
	return accepted.map(({ file, rule, anchor, accepted: stamp, sentence }) => ({ file, rule, anchor, accepted: stamp, sentence }))
}

/** Whether a regeneration may run at all, given the manifest's pinned Biome and the installed
 *  one: a version change is re-pinned only by a deliberate `--adopt` (a plain regen on a bump
 *  that drifted nothing would otherwise move the pin silently), and `--adopt` on the same
 *  version is a growth bypass. */
export type RegenGate = "ok" | "adopt-on-same-version" | "version-changed-without-adopt"
export function regenGate(args: { adopt: boolean; committedVersion: string | undefined; installed: string }): RegenGate {
	if (args.committedVersion === undefined) return "ok"
	if (args.adopt && args.committedVersion === args.installed) return "adopt-on-same-version"
	if (!args.adopt && args.committedVersion !== args.installed) return "version-changed-without-adopt"
	return "ok"
}

export function installedBiomeVersion(rootPackageJson: { devDependencies?: Record<string, string> }): string {
	const v = rootPackageJson.devDependencies?.["@biomejs/biome"]
	if (!v) throw new Error("@biomejs/biome not found in root devDependencies")
	return v
}
