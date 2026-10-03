import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { expectationMatches, GITHUB_ACTIONS_APP_ID, LABELS, normalize, planAdd, planRename } from "./required-checks"

const RENAME = { "contracts-status": "bridge-contracts-status" }
const live = {
	strict: true,
	contexts: ["contracts-status", "quality-status"],
	checks: [
		{ context: "contracts-status", app_id: 15368 },
		{ context: "quality-status", app_id: 15368 },
	],
}

describe("required-checks", () => {
	test("rename maps the aggregators, keeps strict, app ids and unrelated checks, and is idempotent", () => {
		const once = planRename(normalize(live), RENAME)
		expect(once.strict).toBe(true)
		expect(once.checks.map((c) => c.context)).toEqual(["bridge-contracts-status", "quality-status"])
		expect(once.checks.every((c) => c.app_id === 15368)).toBe(true)
		expect(planRename(once, RENAME)).toEqual(once)
	})

	test("rename preserves a check it does not know, and only own rename keys apply", () => {
		const current = normalize({ strict: false, checks: [...live.checks, { context: "some-other-check", app_id: 42 }, { context: "toString", app_id: 7 }] })
		const plan = planRename(current, RENAME)
		expect(plan.checks).toContainEqual({ context: "some-other-check", app_id: 42 })
		expect(plan.checks).toContainEqual({ context: "toString", app_id: 7 })
		expect(plan.strict).toBe(false)
	})

	test("rename refuses to merge two producers of one context", () => {
		const current = normalize({
			strict: false,
			checks: [{ context: "contracts-status", app_id: 15368 }, { context: "bridge-contracts-status", app_id: 42 }],
		})
		expect(() => planRename(current, RENAME)).toThrow(/two producers/)
	})

	test("add appends missing names under the Actions app id, is idempotent, and refuses a foreign producer", () => {
		const plan = planAdd(normalize(live), ["tools-e2e-status", "quality-status"])
		expect(plan.checks).toContainEqual({ context: "tools-e2e-status", app_id: GITHUB_ACTIONS_APP_ID })
		expect(plan.checks.filter((c) => c.context === "quality-status")).toHaveLength(1)
		expect(planAdd(plan, ["tools-e2e-status"])).toEqual(plan)
		const foreign = normalize({ strict: true, checks: [{ context: "tools-e2e-status", app_id: 42 }] })
		expect(() => planAdd(foreign, ["tools-e2e-status"])).toThrow(/two producers/)
	})

	test("expectation is order-insensitive and ignores the deprecated contexts mirror", () => {
		const shuffled = { strict: true, checks: [...live.checks].reverse() }
		expect(expectationMatches(normalize(live), normalize(shuffled)).ok).toBe(true)
		const drifted = { strict: true, checks: [...live.checks, { context: "new-thing", app_id: 15368 }] }
		const r = expectationMatches(normalize(live), normalize(drifted))
		expect(r.ok).toBe(false)
		expect(r.diff).toContain("new-thing")
	})

	test("the force-run labels are exactly the ones the PR workflows honor", () => {
		const dir = join(import.meta.dir, "../../.github/workflows")
		const honored = readdirSync(dir).flatMap((file) =>
			[...readFileSync(join(dir, file), "utf8").matchAll(/labels\.\*\.name, '([^']+)'/g)].map((m) => m[1]),
		)
		expect(LABELS.map((l) => l.name).sort()).toEqual([...new Set(honored)].sort())
	})
})
