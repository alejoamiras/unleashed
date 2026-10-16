import { spawnSync } from "node:child_process"
import { expect, test } from "vitest"

test.each([
	["--expect"],
	["--channel"],
	["--expect", "abc"],
	["--channel", "staging"],
	["--bogus", "x"],
	["--channel", "preview", "--channel", "preview"],
])("refuses the arguments %s", (...args) => {
	const run = spawnSync("bun", [new URL("verify-build.ts", import.meta.url).pathname, ...args], { encoding: "utf8" })
	expect(run.status).toBe(1)
	expect(run.stdout).not.toContain("DIST_SHA256")
})
