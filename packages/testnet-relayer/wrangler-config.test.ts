import { readFileSync } from "node:fs"
import { expect, test } from "vitest"

// The file holds only whole-line `//` comments, so dropping those lines leaves plain JSON.
const config = JSON.parse(
	readFileSync(new URL("./wrangler.jsonc", import.meta.url), "utf8")
		.split("\n")
		.filter((line) => !line.trimStart().startsWith("//"))
		.join("\n"),
) as Record<string, unknown>

// The Worker holds a signing key: it must run from its cron alone and answer nothing over HTTP.
test("the Worker is a cron job with no HTTP surface", () => {
	expect(config.name).toBe("unleashed-testnet-relayer")
	expect(config.main).toBe("src/worker.ts")
	expect(config.triggers).toEqual({ crons: ["* * * * *"] })
	expect(config.workers_dev).toBe(false)
	expect(config.preview_urls).toBe(false)
	for (const key of ["routes", "route", "assets", "build", "alias"]) expect(config).not.toHaveProperty(key)
})

// A secret in `vars` would be committed in clear; the key reaches the Worker as a dashboard secret only.
test("no var names a key", () => {
	expect(Object.keys(config.vars as object)).toEqual(["BASE_SEPOLIA_RPC_URL", "SEPOLIA_RPC_URL"])
})
