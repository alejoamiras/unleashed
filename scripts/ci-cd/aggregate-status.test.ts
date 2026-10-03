/** The aggregator's truth table: every row a filtered PR gate can reach, and what its status must be. */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const ROOT = join(import.meta.dir, "..", "..")
const SCRIPT = join(ROOT, "scripts/ci-cd/aggregate-status.sh")

function aggregate(changes: string, run: string, gated: string): number {
	return Bun.spawnSync(["bash", SCRIPT, changes, run, gated], { stdout: "pipe", stderr: "pipe" }).exitCode
}

describe("aggregate-status.sh", () => {
	test("green only when the filter's verdict and the gated result agree", () => {
		expect(aggregate("success", "true", "success")).toBe(0)
		expect(aggregate("success", "false", "skipped")).toBe(0)
	})

	test("a gated job that never ran is not green", () => {
		expect(aggregate("success", "true", "skipped")).toBe(1)
		expect(aggregate("success", "true", "cancelled")).toBe(1)
		expect(aggregate("success", "true", "failure")).toBe(1)
	})

	test("a job that ran when the filter said not to is an error too", () => {
		expect(aggregate("success", "false", "success")).toBe(1)
		expect(aggregate("success", "false", "failure")).toBe(1)
	})

	test("a filter with no verdict is an error, never a skip", () => {
		expect(aggregate("success", "", "skipped")).toBe(1)
		expect(aggregate("success", "maybe", "success")).toBe(1)
	})

	test("a failed or cancelled filter fails the gate whatever else happened", () => {
		expect(aggregate("failure", "true", "success")).toBe(1)
		expect(aggregate("cancelled", "false", "skipped")).toBe(1)
		expect(aggregate("", "false", "skipped")).toBe(1)
	})

	test("the tools e2e status job runs this script with the three results", () => {
		const wf = readFileSync(join(ROOT, ".github/workflows/pr-tools-e2e.yml"), "utf8")
		expect(wf).toContain("scripts/ci-cd/aggregate-status.sh")
		expect(wf).toMatch(/aggregate-status\.sh "\$\{\{ needs\.changes\.result \}\}" "\$\{\{ needs\.changes\.outputs\.run \}\}" "\$\{\{ needs\.shards\.result \}\}"/)
	})
})
