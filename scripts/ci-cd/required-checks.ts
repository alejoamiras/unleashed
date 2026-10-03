#!/usr/bin/env bun
/**
 * Repoint legacy branch protection's required status checks BY NAME, per branch.
 *
 * Required contexts are matched by the exact check-run name, so renaming an aggregator job
 * breaks merges on that branch until the protection lists the new name. The writes are
 * deliberately narrow: only `required_status_checks` is touched — never signatures, never merge
 * methods — each branch's `strict` flag and every unrelated check keep their values, a rename or
 * add that would merge two producers of one context name is refused, and nothing is written
 * unless the live state still equals a snapshot the owner reviewed beforehand (`--expect`).
 * Needs a `gh` login with admin rights on the repo.
 *
 *   required-checks.sh print --branch main [--json]           # read-only; save the JSON as the snapshot
 *   required-checks.sh --apply --branch main --expect <file>   # rename per RENAMES, verify, print rollback
 *   required-checks.sh --add a,b --branch main --expect <file> # append checks (app_id = GitHub Actions)
 *   required-checks.sh labels                                 # create/update the e2e:* labels (idempotent)
 */
import { parseArgs } from "node:util"

export type Check = { context: string; app_id: number }
export type RequiredChecks = { strict: boolean; checks: Check[] }

/** GitHub Actions' app id — the producer every aggregator job reports under. */
export const GITHUB_ACTIONS_APP_ID = 15368

/** Old aggregator name → new, applied by `--apply`; empty until an aggregator is renamed. */
export const RENAMES: Readonly<Record<string, string>> = {}

/** The force-run labels the PR gates honor; `labels` creates them so a PR can carry them. */
export const LABELS: readonly { name: string; description: string; color: string }[] = [
	{ name: "e2e:tools", description: "Force the tools browser e2e suite on this PR", color: "0e8a16" },
]

const byContext = (a: Check, b: Check) => a.context.localeCompare(b.context) || a.app_id - b.app_id

/** The comparable shape: `strict` + checks sorted, `contexts` (deprecated mirror) dropped. */
export function normalize(rc: { strict: boolean; checks: Check[] }): RequiredChecks {
	return {
		strict: Boolean(rc.strict),
		checks: rc.checks.map((c) => ({ context: c.context, app_id: c.app_id })).sort(byContext),
	}
}

/** One producer per context name: two apps reporting the same name is a conflict, never a merge. */
function assertSingleProducer(checks: Check[]): Check[] {
	const producers = new Map<string, Set<number>>()
	for (const c of checks) producers.set(c.context, (producers.get(c.context) ?? new Set()).add(c.app_id))
	const conflicts = [...producers].filter(([, apps]) => apps.size > 1).map(([ctx, apps]) => `${ctx} (apps ${[...apps].join(", ")})`)
	if (conflicts.length > 0) throw new Error(`refusing: a context would have two producers — ${conflicts.join("; ")}`)
	const seen = new Set<string>()
	return checks.filter((c) => (seen.has(`${c.context}@${c.app_id}`) ? false : (seen.add(`${c.context}@${c.app_id}`), true)))
}

export function planRename(current: RequiredChecks, renames: Readonly<Record<string, string>> = RENAMES): RequiredChecks {
	const checks = current.checks.map((c) => (Object.hasOwn(renames, c.context) ? { ...c, context: renames[c.context] as string } : c))
	return normalize({ strict: current.strict, checks: assertSingleProducer(checks) })
}

export function planAdd(current: RequiredChecks, names: string[], appId = GITHUB_ACTIONS_APP_ID): RequiredChecks {
	const checks = [...current.checks]
	for (const name of names) if (!checks.some((c) => c.context === name && c.app_id === appId)) checks.push({ context: name, app_id: appId })
	return normalize({ strict: current.strict, checks: assertSingleProducer(checks) })
}

/** Live state must equal the reviewed snapshot exactly (order-insensitive), or nothing is written. */
export function expectationMatches(live: RequiredChecks, expected: RequiredChecks): { ok: boolean; diff: string } {
	const a = JSON.stringify(normalize(live))
	const b = JSON.stringify(normalize(expected))
	return a === b ? { ok: true, diff: "" } : { ok: false, diff: `live:     ${a}\nexpected: ${b}` }
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

async function gh(args: string[], input?: string): Promise<string> {
	const proc = Bun.spawn(["gh", ...args], { stdin: input === undefined ? "ignore" : new Blob([input]), stdout: "pipe", stderr: "pipe" })
	const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
	if (code !== 0) throw new Error(`gh ${args.join(" ")} failed (${code}): ${err.trim()}`)
	return out
}

async function ensureLabels(repo: string): Promise<void> {
	for (const l of LABELS) {
		// `--force` updates an existing label in place, so the call is idempotent.
		await gh(["label", "create", l.name, "--repo", repo, "--description", l.description, "--color", l.color, "--force"])
		console.log(`${repo}: label ${l.name} present`)
	}
}

async function main(): Promise<void> {
	const { values, positionals } = parseArgs({
		args: Bun.argv.slice(2),
		allowPositionals: true,
		options: {
			branch: { type: "string" },
			json: { type: "boolean", default: false },
			apply: { type: "boolean", default: false },
			add: { type: "string" },
			expect: { type: "string" },
		},
	})
	const repo = (await gh(["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"])).trim()
	if (positionals[0] === "labels") return ensureLabels(repo)

	const branch = values.branch
	if (!branch) throw new Error("--branch <name> is required")
	const endpoint = `repos/${repo}/branches/${branch}/protection/required_status_checks`
	const live = normalize(JSON.parse(await gh(["api", endpoint])) as RequiredChecks)

	if (positionals[0] === "print" || (!values.apply && !values.add)) {
		console.log(values.json ? JSON.stringify(live, null, 2) : `${repo}@${branch}: strict=${live.strict}\n${live.checks.map((c) => `  ${c.context} (app ${c.app_id})`).join("\n")}`)
		return
	}

	if (!values.expect) throw new Error("--apply/--add require --expect <snapshot.json> (from `print --json`, reviewed beforehand)")
	const expected = normalize(JSON.parse(await Bun.file(values.expect).text()) as RequiredChecks)
	const match = expectationMatches(live, expected)
	if (!match.ok) throw new Error(`refusing: live protection on ${branch} differs from the reviewed snapshot\n${match.diff}`)

	const plan = values.add ? planAdd(live, values.add.split(",").map((s) => s.trim()).filter(Boolean)) : planRename(live)
	if (JSON.stringify(plan) === JSON.stringify(live)) {
		console.log(`${repo}@${branch}: nothing to change`)
		return
	}
	const backup = `${values.expect}.pre-apply.${Date.now()}.json`
	await Bun.write(backup, JSON.stringify({ strict: live.strict, checks: live.checks }, null, 2))
	await gh(["api", "--method", "PATCH", endpoint, "--input", "-"], JSON.stringify({ strict: plan.strict, checks: plan.checks }))
	const after = normalize(JSON.parse(await gh(["api", endpoint])) as RequiredChecks)
	const verified = expectationMatches(after, plan)
	if (!verified.ok) throw new Error(`write did not verify on ${branch}\n${verified.diff}\nrollback: gh api --method PATCH ${endpoint} --input ${backup}`)
	console.log(`${repo}@${branch}: applied\n${after.checks.map((c) => `  ${c.context}`).join("\n")}\nrollback: gh api --method PATCH ${endpoint} --input ${backup}`)
}

if (import.meta.main) {
	main().catch((e) => {
		console.error(`required-checks: ${e instanceof Error ? e.message : String(e)}`)
		process.exit(1)
	})
}
