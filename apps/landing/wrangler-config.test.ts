import { readFileSync } from "node:fs"
import { expect, test } from "vitest"

// The file holds only whole-line `//` comments, so dropping those lines leaves plain JSON.
const config = JSON.parse(
	readFileSync(new URL("./wrangler.jsonc", import.meta.url), "utf8")
		.split("\n")
		.filter((line) => !line.trimStart().startsWith("//"))
		.join("\n"),
) as Record<string, unknown>

// A keyed deploy runs `wrangler deploy` with this file beside a Cloudflare token: a `build` would run
// arbitrary commands, and `main` or `alias` would bundle a script into an assets-only Worker.
test("the Worker is assets only and runs nothing at deploy", () => {
	expect(config.name).toBe("unleashed-landing")
	expect(config).not.toHaveProperty("main")
	expect(config).not.toHaveProperty("build")
	expect(config).not.toHaveProperty("alias")
	expect(config).not.toHaveProperty("routes")
	expect(config.assets).toEqual({ directory: "./dist", not_found_handling: "single-page-application" })
	expect(config.preview_urls).toBe(true)
})
