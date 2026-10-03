import { describe, expect, it } from "vitest"
import { previewAlias, workerOf } from "./preview-hosts"

const HOST = "unleashed-testnet.alejo-amiras.workers.dev"
const WORKER = "unleashed-testnet"
const LABEL = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/

describe("previewAlias", () => {
	it("yields one valid DNS label with the worker, whatever the branch name", () => {
		for (const branch of [
			"feature-with-a-long-descriptive-name",
			"Feat/Fancy_Branch!!",
			"../../etc/passwd",
			"--",
			"日本語",
			"1-starts-with-a-digit",
			"a".repeat(300),
			`${"x".repeat(33)}-tail`,
		]) {
			const label = `${previewAlias(branch, WORKER)}-${WORKER}`
			expect(label, branch).toMatch(LABEL)
			expect(label.length, branch).toBeLessThanOrEqual(63)
			expect(label, branch).toMatch(/^p-[0-9a-f]{32}/)
		}
	})

	it("keeps a readable slug, and tells apart branches that truncate to the same one", () => {
		expect(previewAlias("feat/send-wizard", WORKER)).toMatch(/^p-[0-9a-f]{32}-feat-send$/)
		const long = "b".repeat(80)
		expect(previewAlias(`${long}-one`, WORKER)).not.toBe(previewAlias(`${long}-two`, WORKER))
	})

	it("separates two branches whose first 32 bits of digest collide", () => {
		const long = "x".repeat(80)
		expect(previewAlias(`${long}-33513`, WORKER)).not.toBe(previewAlias(`${long}-49412`, WORKER))
	})

	it("refuses a worker name that leaves no room", () => {
		expect(() => previewAlias("x", "w".repeat(60))).toThrow(/no room/)
	})
})

describe("workerOf", () => {
	it("names the Worker of a workers.dev host, and refuses a host that has none", () => {
		expect(workerOf(HOST)).toBe(WORKER)
		// A custom domain serves no preview, and a target without a workers.dev host passes "".
		for (const host of ["testnet.app.unleashed.systems", ""]) expect(() => workerOf(host)).toThrow(/workers\.dev/)
	})
})
