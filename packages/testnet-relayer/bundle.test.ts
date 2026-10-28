import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"

const here = import.meta.dirname

// Workers Builds deploys what wrangler bundles from src/worker.ts; a `node:` builtin or an Aztec module in that
// graph fails there, after the merge, not here. Spawning wrangler takes seconds, hence the explicit timeout.
it("bundles the Worker with neither a Node builtin nor an Aztec module", { timeout: 60_000 }, () => {
	const outdir = mkdtempSync(join(tmpdir(), "testnet-relayer-bundle-"))
	try {
		const run = spawnSync(join(here, "node_modules", ".bin", "wrangler"), ["deploy", "--dry-run", "--outdir", outdir], {
			cwd: here,
			encoding: "utf8",
			env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
		})
		expect(run.status, run.stderr).toBe(0)
		const bundle = readFileSync(join(outdir, "worker.js"), "utf8")
		expect(bundle).not.toMatch(/(?:from|import|require)\s*\(?\s*"node:/)
		expect(bundle).not.toContain("@aztec")
	} finally {
		rmSync(outdir, { recursive: true, force: true })
	}
})
