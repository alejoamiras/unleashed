/**
 * Fast local enforcement of the complexity-budget baseline (sub-second: one git grep).
 * Chained into `bun run lint` and the pre-commit hook so a violation reds the agent's
 * local loop, not just CI. The tree must match the manifest exactly, entry by entry.
 * scripts/ci-cd/complexity-baseline.test.ts is the CI mirror and adds the ratchet against
 * the PR's base branch (a hand-edited manifest passes here but not there);
 * scripts/ci-cd/complexity-rescore.test.ts holds every stamp to the function's observed value
 * (that one needs Biome, so it is CI + on-demand: `bun run baseline:rescore`).
 */
import { readFileSync } from "node:fs"
import { type BaselineManifest, diffEntries, hasEntries, installedBiomeVersion, ruleCountsOf, scanTree, toManifestEntries } from "./scan"

const manifest: BaselineManifest = JSON.parse(readFileSync("scripts/complexity-baseline/manifest.json", "utf8"))
const rootPkg = JSON.parse(readFileSync("package.json", "utf8"))

// --staged scans the index instead of the working tree — the pre-commit hook uses it
// so what gets checked is exactly what the commit captures (split-staging can't evade).
const staged = process.argv.includes("--staged")

const problems: string[] = []

const installed = installedBiomeVersion(rootPkg)
if (manifest.biomeVersion !== installed) {
	problems.push(
		`Biome ${installed} installed but the baseline was generated under ${manifest.biomeVersion} — scores drift ` +
			"between releases. In this PR: `bun run baseline:rescore` to see every drifted stamp, edit each directive " +
			"to its observed value (or refactor), then `bun run baseline:complexity -- --adopt` and review the manifest diff.",
	)
}
if (!hasEntries(manifest)) {
	problems.push("manifest.json carries no per-acceptance entries — restore it from git; it is only ever written by `bun run baseline:complexity`.")
}

const scan = scanTree({ staged })
for (const f of scan.forbidden) {
	problems.push(`${f.file}:${f.line} — forbidden suppression: ${f.why}`)
}

const diff = diffEntries(manifest.accepted ?? [], toManifestEntries(scan.accepted))
const list = (items: string[]) => `\n  ${items.join("\n  ")}`
if (diff.added.length > 0) {
	problems.push(
		"New complexity acceptance(s) — the baseline only shrinks. Refactor the function under the budget " +
			`instead of accepting it:${list(diff.added.map((e) => `${e.file} ${e.rule} — ${e.anchor}`))}`,
	)
}
if (diff.restamped.length > 0) {
	problems.push(
		"Accepted stamp(s) changed — a stamp is the function's exact observed value. Confirm with `bun run baseline:rescore`, " +
			`then record it: \`bun run baseline:complexity\` (a Biome bump needs \`-- --adopt\`):${list(diff.restamped.map((r) => `${r.key}: ${r.from} → ${r.to}`))}`,
	)
}
if (diff.removed.length > 0) {
	problems.push(`Accepted function(s) fixed or removed — record the progress: rerun \`bun run baseline:complexity\` in this PR:${list(diff.removed.map((e) => `${e.file} ${e.rule} — ${e.anchor}`))}`)
}
if (diff.moved.length > 0) {
	problems.push(`Accepted declaration(s) renamed or moved — rerun \`bun run baseline:complexity\` so the manifest follows:${list(diff.moved.map((m) => `${m.from.file} — ${m.from.anchor}  →  ${m.to.file} — ${m.to.anchor}`))}`)
}
if (diff.reworded.length > 0) {
	problems.push(`Accepted sentence(s) edited — rerun \`bun run baseline:complexity\` so the manifest carries the new wording:${list(diff.reworded)}`)
}
if (hasEntries(manifest) && JSON.stringify(manifest.rules) !== JSON.stringify(ruleCountsOf(manifest.accepted))) {
	problems.push("manifest.json's `rules` summary does not match its entries — it was edited by hand; rerun `bun run baseline:complexity`.")
}

if (problems.length > 0) {
	console.error("complexity-baseline check FAILED (AGENTS.md, complexity budgets):")
	for (const p of problems) console.error(`\n• ${p}`)
	process.exit(1)
}
console.log("complexity-baseline check OK")
