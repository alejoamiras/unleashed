import { spawnSync } from "node:child_process"
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

describe("lifi-fixtures --run", () => {
	// Every assertion is a boolean, since a failing `toContain` on captured output would print the key.
	it("redacts what forge prints, on both streams, and fails the run", () => {
		const key = "sentinel_Key-0123456789"
		const forge = join(mkdtempSync(join(tmpdir(), "lifi-fixtures-")), "forge")
		writeFileSync(forge, '#!/bin/sh\necho "fork at $SEPOLIA_RPC_URL"\necho "error: $SEPOLIA_RPC_URL" >&2\nexit 1\n')
		chmodSync(forge, 0o755)
		const child = spawnSync("bun", [join(import.meta.dirname, "lifi-fixtures.ts"), "--run"], {
			encoding: "utf8",
			timeout: 60_000,
			env: { ...process.env, NODE_ENV: "production", FORGE_BIN: forge, SEPOLIA_RPC_URL: `http://127.0.0.1:9/${key}` },
		})
		expect(child.status, "the run failed").toBe(1)
		expect(`${child.stdout}${child.stderr}`.includes(key)).toBe(false)
		expect(child.stdout.includes("fork at <SEPOLIA_RPC_URL>")).toBe(true)
		expect(child.stderr.includes("error: <SEPOLIA_RPC_URL>")).toBe(true)
	})
})
