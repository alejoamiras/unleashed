/**
 * The rescore audit: every accepted directive's stamp must EQUAL the function's observed value.
 * A stamp above the truth is a raised ceiling nobody reviewed; a stamp below it is a function
 * that grew under a still-"valid" sentence; no remaining diagnostic means a directive outlived its
 * function. All three fail.
 *
 * Mechanics: one sibling copy per file with ALL of its accepted budget directives removed (Biome's
 * stdin mode prints processed code, not diagnostics, so a real path is the only way), originals +
 * copies linted in ONE Biome run, diagnostics paired with directives by file → rule → sorted
 * source position. Originals must produce zero budget diagnostics (an unsuppressed offender fails
 * closed). Copies are untracked siblings (the manifest's `git grep` never sees them), created
 * exclusively and removed in `finally`.
 *
 * `bun run baseline:rescore` runs it over the tree; scripts/ci-cd/complexity-rescore.test.ts is
 * the CI mirror and exercises the audit with injected descriptors.
 */
import { spawnSync } from "node:child_process"
import { readFileSync, rmSync, writeFileSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parseObserved } from "./messages"
import { type AcceptedDirective, BASELINED_RULES, type BaselinedRule, scanTree } from "./scan"

const CATEGORY_PREFIX = "lint/complexity/"

export interface RescoreResult {
	checked: number
	violations: string[]
}

interface Diagnostic {
	path: string
	category: string
	message: string
	line: number
}

/** `Foo.test.ts` → `Foo.rescore-<pid>.test.ts`: every suffix stays so Biome's path-glob overrides apply to the copy. */
export function siblingCopyPath(file: string, tag = String(process.pid)): string {
	const base = basename(file)
	const dot = base.indexOf(".")
	const copy = dot === -1 ? `${base}.rescore-${tag}` : `${base.slice(0, dot)}.rescore-${tag}${base.slice(dot)}`
	return join(dirname(file), copy)
}

function normalisePath(p: string): string {
	return p.replace(/^\.\//, "")
}

function lintPaths(paths: string[], cwd: string): { diagnostics: Diagnostic[]; parseErrors: string[] } {
	const res = spawnSync("bunx", ["biome", "lint", "--reporter=json", "--max-diagnostics=none", ...paths], {
		cwd,
		encoding: "utf8",
		maxBuffer: 256 * 1024 * 1024,
	})
	if (!res.stdout) throw new Error(`biome lint produced no output: ${res.stderr}`)
	const report = JSON.parse(res.stdout)
	const notPrinted = report.summary?.diagnosticsNotPrinted ?? 0
	if (notPrinted > 0) throw new Error(`biome truncated ${notPrinted} diagnostic(s) — the audit would be incomplete`)
	const all = (report.diagnostics ?? []) as Array<{ category?: string; message: string; location: { path: string; start?: { line: number } } }>
	const parseErrors = all.filter((d) => (d.category ?? "").startsWith("parse")).map((d) => `${d.location.path}: ${d.message}`)
	const diagnostics = all
		.filter((d) => (d.category ?? "").startsWith(CATEGORY_PREFIX))
		.map((d) => ({
			path: normalisePath(d.location.path),
			category: (d.category as string).slice(CATEGORY_PREFIX.length),
			message: d.message,
			line: d.location.start?.line ?? 0,
		}))
	return { diagnostics, parseErrors }
}

function isBaselined(category: string): category is BaselinedRule {
	return (BASELINED_RULES as readonly string[]).includes(category)
}

/** Audits the given directives (normally `scanTree().accepted`; a test may inject its own). */
export function rescore(directives: AcceptedDirective[], opts: { cwd?: string } = {}): RescoreResult {
	const cwd = opts.cwd ?? process.cwd()
	const byFile = new Map<string, AcceptedDirective[]>()
	for (const d of directives) byFile.set(d.file, [...(byFile.get(d.file) ?? []), d])
	const created: string[] = []
	const copyOf = new Map<string, string>()
	const violations: string[] = []
	try {
		for (const [file, list] of byFile) {
			const remove = new Set(list.map((d) => d.line))
			const kept = readFileSync(resolve(cwd, file), "utf8")
				.split("\n")
				.filter((_, i) => !remove.has(i + 1))
			const copy = siblingCopyPath(file)
			writeFileSync(resolve(cwd, copy), kept.join("\n"), { flag: "wx" })
			created.push(resolve(cwd, copy))
			copyOf.set(file, copy)
		}
		const { diagnostics, parseErrors } = lintPaths([...byFile.keys(), ...copyOf.values()], cwd)
		if (parseErrors.length > 0) throw new Error(`the audit cannot score a file Biome failed to parse:\n  ${parseErrors.join("\n  ")}`)
		for (const [file, list] of byFile) {
			for (const d of diagnostics) {
				if (d.path === file && isBaselined(d.category)) violations.push(`${file}:${d.line} ${d.category} — unsuppressed offender (observed ${parseObserved(d.category, d.message)})`)
			}
			for (const rule of BASELINED_RULES) {
				const expected = list.filter((d) => d.rule === rule).sort((a, b) => a.line - b.line)
				const observed = diagnostics.filter((d) => d.path === copyOf.get(file) && d.category === rule).sort((a, b) => a.line - b.line)
				violations.push(...pairAndCompare(file, rule, expected, observed))
			}
		}
	} finally {
		for (const p of created) rmSync(p, { force: true })
	}
	return { checked: directives.length, violations }
}

function pairAndCompare(file: string, rule: BaselinedRule, expected: AcceptedDirective[], observed: Diagnostic[]): string[] {
	if (expected.length === 0 && observed.length === 0) return []
	if (expected.length !== observed.length) {
		const stale = expected.length > observed.length ? "a directive no longer has a function over budget under it — remove it and regenerate" : "more offenders than directives"
		return [`${file} ${rule} — ${expected.length} accepted directive(s) but ${observed.length} diagnostic(s) once removed: ${stale}`]
	}
	const out: string[] = []
	for (let i = 0; i < expected.length; i++) {
		const stamp = expected[i]
		const actual = parseObserved(rule, observed[i].message)
		if (actual !== stamp.accepted) {
			const verb = actual > stamp.accepted ? "grew past" : "fell below"
			out.push(`${file}:${stamp.line} ${rule} — accepted ${stamp.accepted} → observed ${actual} (the function ${verb} its stamp; edit the stamp to ${actual} or refactor)`)
		}
	}
	return out
}

const isMain = process.argv[1] ? fileURLToPath(import.meta.url) === resolve(process.argv[1]) : false
if (isMain) {
	const result = rescore(scanTree().accepted)
	if (result.violations.length > 0) {
		console.error(`complexity rescore FAILED — ${result.violations.length} of ${result.checked} acceptance(s) do not match the function:`)
		for (const v of result.violations) console.error(`  • ${v}`)
		process.exit(1)
	}
	console.log(`complexity rescore OK — ${result.checked} acceptance(s) match their functions exactly`)
}
