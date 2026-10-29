import { spawnSync } from "node:child_process"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { requireDrpcNodeUrl } from "../src/drpc-node"

// Children run with the operator's environment: vitest's NODE_ENV=test silences the SDK's logger. Every assertion is a
// boolean, since a failing `toContain` on captured output would print the key.
const key = "sentinel_Key-0123456789"
const packageDir = join(import.meta.dirname, "..")

function bun(cwd: string, source: string, env: Record<string, string> = {}): { status: number | null; stdout: string; stderr: string } {
	const child = spawnSync("bun", ["-e", source], {
		cwd,
		encoding: "utf8",
		timeout: 60_000,
		env: { ...process.env, NODE_ENV: "production", LOG_LEVEL: "info", DRPC_API_KEY: key, ...env },
	})
	return { status: child.status, stdout: child.stdout, stderr: child.stderr }
}

describe("runKeyed", () => {
	it("keeps the keyed URL out of the node client's retry log and out of the run's failure", () => {
		const { status, stdout, stderr } = bun(
			packageDir,
			`import { createAztecNodeClient } from "@aztec-labs/aztec.js/node"
			import { makeFetch } from "@aztec-labs/foundation/json-rpc/client"
			import { runKeyed } from "./scripts/keyed-run.ts"
			runKeyed(() => createAztecNodeClient(process.env.PROBE_URL, { fetch: makeFetch([0], false) }).getBlockNumber())`,
			{ PROBE_URL: `http://127.0.0.1:9/aztec?dkey=${key}` },
		)
		const lines = stderr.split("\n")
		const retry = lines.filter((line) => line.includes("Error while retrying"))
		expect(status, "the run failed").toBe(1)
		expect(retry.length > 0, "the SDK logged its retry").toBe(true)
		expect(`${stdout}${stderr}`.includes(key)).toBe(false)
		expect(retry.every((line) => line.includes("<DRPC_API_KEY>"))).toBe(true)
		expect(lines.some((line) => !line.includes("Error while retrying") && line.includes("<DRPC_API_KEY>"))).toBe(true)
	})

	it("redacts a long error property whole, not after inspect's string cut", () => {
		const { status, stderr } = bun(
			packageDir,
			`import { runKeyed } from "./scripts/keyed-run.ts"
			runKeyed(async () => { throw Object.assign(new Error("cast failed"), { stderr: "x".repeat(9_990) + process.env.DRPC_API_KEY }) })`,
		)
		expect(status, "the run failed").toBe(1)
		expect(stderr.includes(key.slice(0, 10))).toBe(false)
		expect(stderr.includes("<DRPC_API_KEY>")).toBe(true)
	})
})

describe("keyedNodeUrl", () => {
	// From apps/tools, as the tools deploy imports it: the package subpath and the relative path must be one module.
	it("refuses before runKeyed starts and composes inside it", () => {
		const { status, stdout } = bun(
			join(packageDir, "..", "..", "apps", "tools"),
			`import { runKeyed } from "@unleashed/bridge-core/keyed-run"
			import { keyedNodeUrl } from "../../packages/bridge-core/scripts/keyed-run.ts"
			let refused = false
			try { keyedNodeUrl("testnet") } catch { refused = true }
			await runKeyed(async () => console.log(JSON.stringify({ refused, composed: keyedNodeUrl("testnet") === process.env.EXPECTED })))`,
			{ EXPECTED: requireDrpcNodeUrl("testnet", { DRPC_API_KEY: key }) },
		)
		expect(status).toBe(0)
		expect(stdout.trim()).toBe(JSON.stringify({ refused: true, composed: true }))
	})
})
