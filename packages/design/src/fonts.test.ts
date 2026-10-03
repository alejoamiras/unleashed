/// <reference types="node" />
import { createHash } from "node:crypto"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "vitest"

const FONTS = join(process.cwd(), "src/fonts")

/** `file → output sha256` from the SOURCES.md table: the first and sixth cells of each woff2 row. */
function recorded(): Map<string, string> {
	const rows = readFileSync(join(FONTS, "SOURCES.md"), "utf8").split("\n")
	const out = new Map<string, string>()
	for (const row of rows) {
		const cells = row.split("|").map((c) => c.trim().replaceAll("`", ""))
		if (cells[1]?.endsWith(".woff2") && /^[0-9a-f]{64}$/.test(cells[6] ?? "")) out.set(cells[1], cells[6])
	}
	return out
}

describe("vendored fonts", () => {
	test("every woff2 matches the output hash SOURCES.md records for it", () => {
		const hashes = recorded()
		const files = readdirSync(FONTS).filter((f) => f.endsWith(".woff2"))
		expect(files.sort()).toEqual([...hashes.keys()].sort())
		for (const f of files) {
			expect(
				createHash("sha256")
					.update(readFileSync(join(FONTS, f)))
					.digest("hex"),
				f,
			).toBe(hashes.get(f))
		}
	})
})
