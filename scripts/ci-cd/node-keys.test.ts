import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * No file in the tree holds a dRPC key. A keyed endpoint takes its key as a path segment or a
 * `dkey` query parameter, so a committed URL is a key anyone can spend on the owner's account:
 * scripts compose the URL at run time from a keyed run's `DRPC_API_KEY` instead, and the browser
 * uses the keyless endpoint. Archived records count too. Untracked files that git does not ignore
 * count, so a file is checked before its first commit. A failure names paths and counts, never the
 * match.
 */
const ROOT = join(import.meta.dir, "..", "..")
// lb.drpc.live's path form (any case, a port, escaped slashes), or `dkey=` in a URL on any drpc host.
const KEYED_URL = /lb\.drpc\.live(?::\d+)?\\*\/[a-z0-9-]+\\*\/[A-Za-z0-9_-]{12,}|drpc[^\s"'<>]*?dkey=[A-Za-z0-9_-]{12,}/gi

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

const keyedUrls = (text: string): number => text.match(KEYED_URL)?.length ?? 0

test("the matcher catches every spelling of a keyed URL and passes the keyless endpoint", () => {
	// Assembled at run time, so this file never matches its own pattern; failures print labels and counts.
	const key = ["synthetic", "Key", "0123456789"].join("_")
	const host = ["lb", "drpc", "live"].join(".")
	const pathForm = `https://${host}/aztec-testnet/${key}`
	const spellings: Record<string, string> = {
		"path form": pathForm,
		"query form": `https://${["lb", "drpc", "org"].join(".")}/ogrpc?network=aztec-testnet&dkey=${key}`,
		"JSON-escaped slashes": pathForm.replaceAll("/", "\\/"),
		"uppercase host": pathForm.replace(host, host.toUpperCase()),
		"explicit port": pathForm.replace(host, `${host}:443`),
		"keyless endpoint": "https://aztec-testnet.drpc.org",
	}
	expect(Object.entries(spellings).map(([label, text]) => `${label}: ${keyedUrls(text)}`)).toEqual([
		"path form: 1",
		"query form: 1",
		"JSON-escaped slashes: 1",
		"uppercase host: 1",
		"explicit port: 1",
		"keyless endpoint: 0",
	])
})

test("no file in the tree holds a dRPC key", () => {
	expect(files.length).toBeGreaterThan(500)
	const hits = files.flatMap((path) => {
		const count = keyedUrls(textOf(path) ?? "")
		return count > 0 ? [`${path}: ${count}`] : []
	})
	expect(hits).toEqual([])
})
