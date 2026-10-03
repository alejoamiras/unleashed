/**
 * Regenerates the complexity-budget baseline manifest from an actual source scan. Run from the
 * repo root: `bun run baseline:complexity`. Idempotent on a clean tree.
 *
 * Fail-closed on new offenders: every function that currently exceeds a baselined rule gets a
 * `JUSTIFICATION REQUIRED` marker inserted above it — a form the scanner REFUSES — and the run
 * exits 1 listing them without writing the manifest. A human replaces each marker with
 * `accepted at … — <why>` (or refactors) and re-runs. Existing directives are never rewritten.
 *
 * The manifest only shrinks on its own: removals, lowered stamps, reworded sentences and moves
 * (a renamed declaration or moved file keeping rule, stamp and sentence) regenerate freely. A
 * new acceptance or a raised stamp needs `--adopt`, and `--adopt` is accepted ONLY when the
 * installed Biome differs from the manifest's pin — a version bump, the one legitimate reason
 * numbers rise — never as a general-purpose bypass. CI applies the same ratchet against the PR's
 * base branch, so a hand-edited manifest does not get past review either.
 */
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { markerFor, parseObserved } from "./messages"
import {
	type BaselineManifest,
	type CountsOnlyManifest,
	BASELINED_RULES,
	type BaselinedRule,
	diffEntries,
	hasEntries,
	installedBiomeVersion,
	MOVE_APPROVED_LABEL,
	ratchetViolations,
	regenGate,
	scanTree,
	toManifestEntries,
} from "./scan"

const CATEGORY_PREFIX = "lint/complexity/"
const MANIFEST_PATH = "scripts/complexity-baseline/manifest.json"

interface Finding {
	rule: BaselinedRule
	line: number
	observed: number
}

function lint(): { path: string; category: string; message: string; line: number }[] {
	const res = spawnSync("bunx", ["biome", "lint", "--reporter=json", "--max-diagnostics=none", "."], {
		encoding: "utf8",
		maxBuffer: 256 * 1024 * 1024,
	})
	if (!res.stdout) throw new Error(`biome lint produced no output: ${res.stderr}`)
	const report = JSON.parse(res.stdout)
	const notPrinted = report.summary?.diagnosticsNotPrinted ?? 0
	if (notPrinted > 0) throw new Error(`biome truncated ${notPrinted} diagnostic(s) — the baseline would be incomplete`)
	return (report.diagnostics ?? [])
		.filter((d: { category?: string }) => (d.category ?? "").startsWith(CATEGORY_PREFIX))
		.map((d: { category: string; message: string; location: { path: string; start: { line: number } } }) => ({
			path: d.location.path,
			category: d.category.slice(CATEGORY_PREFIX.length),
			message: d.message,
			line: d.location.start.line,
		}))
}

function isBaselined(category: string): category is BaselinedRule {
	return (BASELINED_RULES as readonly string[]).includes(category)
}

const adopt = process.argv.includes("--adopt")
const rootPkg = JSON.parse(readFileSync("package.json", "utf8"))
const installed = installedBiomeVersion(rootPkg)
const committed: BaselineManifest | CountsOnlyManifest | undefined = existsSync(MANIFEST_PATH) ? JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) : undefined
if (committed !== undefined && !hasEntries(committed)) {
	console.error(`ERROR: ${MANIFEST_PATH} carries no per-acceptance entries — restore it from git before regenerating.`)
	process.exit(1)
}
const gate = regenGate({ adopt, committedVersion: committed?.biomeVersion, installed })
if (gate === "adopt-on-same-version") {
	console.error(`ERROR: --adopt is only for a Biome version bump; the manifest already pins the installed ${installed}.`)
	console.error("Growth is never adopted on the same Biome: refactor the function under the budget instead.")
	process.exit(1)
}
if (gate === "version-changed-without-adopt") {
	console.error(`ERROR: Biome changed ${committed?.biomeVersion} → ${installed}; the manifest is re-pinned only with --adopt.`)
	console.error("In the bump PR: `bun run baseline:rescore`, re-stamp each drifted directive by hand, then `bun run baseline:complexity -- --adopt`.")
	process.exit(1)
}

const byFile = new Map<string, Finding[]>()
for (const d of lint()) {
	if (!isBaselined(d.category)) continue
	const list = byFile.get(d.path) ?? []
	list.push({ rule: d.category, line: d.line, observed: parseObserved(d.category, d.message) })
	byFile.set(d.path, list)
}

const inserted: string[] = []
for (const [path, findings] of byFile) {
	const lines = readFileSync(path, "utf8").split("\n")
	// Bottom-up so earlier insertions never shift later target lines.
	findings.sort((a, b) => b.line - a.line)
	for (const f of findings) {
		const idx = f.line - 1
		const above = lines[idx - 1] ?? ""
		if (above.includes(`biome-ignore lint/complexity/${f.rule}`)) continue
		const indent = lines[idx]?.match(/^[\t ]*/)?.[0] ?? ""
		lines.splice(idx, 0, `${indent}${markerFor(f.rule, f.observed)}`)
		inserted.push(`${path}:${f.line} ${f.rule} (${f.observed})`)
	}
	writeFileSync(path, lines.join("\n"))
}
if (inserted.length > 0) {
	console.error(`ERROR: ${inserted.length} function(s) exceed a budget and now carry a JUSTIFICATION REQUIRED marker:`)
	for (const i of inserted) console.error(`  ${i}`)
	console.error("Refactor each under the budget, or replace its marker with `accepted at … — <why>`, then re-run.")
	console.error("The manifest was not written; the markers remain in the source until you resolve them.")
	process.exit(1)
}

const scan = scanTree()
if (scan.forbidden.length > 0) {
	console.error("ERROR: forbidden suppression form(s) in the tree — fix these before regenerating:")
	for (const f of scan.forbidden) console.error(`  ${f.file}:${f.line} — ${f.why}`)
	process.exit(1)
}

const entries = toManifestEntries(scan.accepted)
if (committed) {
	const diff = diffEntries(committed.accepted, entries)
	// A move regenerates locally so the manifest can follow a rename; CI is where it needs the label.
	const violations = ratchetViolations(diff, { movesApproved: true })
	const adoptAllowed = adopt && committed.biomeVersion !== installed
	if (violations.length > 0 && !adoptAllowed) {
		console.error("ERROR: regeneration would GROW the baseline — refusing. New or raised acceptances:")
		for (const v of violations) console.error(`  ${v}`)
		console.error("Refactor the function(s) under the budget instead; `--adopt` exists only for a Biome version bump.")
		process.exit(1)
	}
	for (const m of diff.moved) console.log(`moved (CI needs the owner's ${MOVE_APPROVED_LABEL} label): ${m.from.file} — ${m.from.anchor}  →  ${m.to.file} — ${m.to.anchor}`)
	for (const k of diff.reworded) console.log(`reworded: ${k}`)
}

const manifest: BaselineManifest = {
	biomeVersion: installed,
	rules: scan.ruleCounts,
	accepted: entries,
}
writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, "\t")}\n`)
const totals = BASELINED_RULES.map((r) => `${r}: ${Object.values(manifest.rules[r]).reduce((a, b) => a + b, 0)}`).join(", ")
console.log(`manifest written (biome ${manifest.biomeVersion}) — ${totals}; ${manifest.accepted.length} acceptance(s)`)
