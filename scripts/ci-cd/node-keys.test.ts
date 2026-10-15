import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * No file in the tree holds a dRPC key. The keyed endpoint takes its key as a path segment, so a
 * committed URL is a key anyone can spend on the owner's account: scripts compose the URL at run time
 * from a keyed run's `DRPC_API_KEY` instead, and the browser uses the keyless endpoint. Archived
 * records count too. Untracked files that git does not ignore count, so a file is checked before its
 * first commit. A failure names paths and counts, never the match.
 */
const ROOT = join(import.meta.dir, "..", "..")
const KEYED_URL = /lb\.drpc\.live\/[a-z0-9-]+\/[A-Za-z0-9_-]{12,}/g

const files = Bun.spawnSync(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: ROOT })
	.stdout.toString()
	.split("\0")
	.filter(Boolean)

/** The file's text, or null for a path that is no longer a readable file (deleted, a directory). */
function textOf(path: string): string | null {
	try {
		return readFileSync(join(ROOT, path), "utf8")
	} catch {
		return null
	}
}

test("no file in the tree holds a dRPC key", () => {
	expect(files.length).toBeGreaterThan(500)
	const hits = files.flatMap((path) => {
		const count = textOf(path)?.match(KEYED_URL)?.length ?? 0
		return count > 0 ? [`${path}: ${count}`] : []
	})
	expect(hits).toEqual([])
})
