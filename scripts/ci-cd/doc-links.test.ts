import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { dirname, join, posix } from "node:path"

/**
 * Every relative link in an operational doc resolves to a file or directory in this repository. The
 * archived plans and the audit reports are history and keep their links as written; the curated
 * files at the root of implementations-plan/ and the archive index are operational. Untracked files
 * that git does not ignore count, so a doc can be checked before its first commit.
 */
const ROOT = join(import.meta.dir, "..", "..")

const files = Bun.spawnSync(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: ROOT })
	.stdout.toString()
	.split("\0")
	.filter(Boolean)
const paths = new Set(files.flatMap((f) => f.split("/").map((_, i, parts) => parts.slice(0, i + 1).join("/"))))

const operational = (f: string) =>
	f.endsWith(".md") && !f.startsWith("audit/") && (!f.startsWith("implementations-plan/") || /^implementations-plan\/(archive\/)?[^/]+\.md$/.test(f))

const INLINE = /\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g
const REFERENCE = /^\s*\[[^\]]+\]:\s*<?(\S+?)>?(?:\s|$)/gm
const FENCE = /^(```|~~~)[^\n]*\n[\s\S]*?^\1/gm
/** A code span is text, never a link; `[`name`](path)` keeps its link once the span is gone. */
const CODE_SPAN = /`[^`\n]*`/g

/** The repo-relative path a link target names, or null for a URL, an anchor or a mail link. */
export function resolveLink(doc: string, target: string): string | null {
	if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("#")) return null
	const path = decodeURIComponent(target.replace(/[?#].*$/, ""))
	if (path === "") return null
	return posix.normalize(path.startsWith("/") ? path.slice(1) : posix.join(dirname(doc), path)).replace(/\/$/, "")
}

function links(doc: string): string[] {
	const text = readFileSync(join(ROOT, doc), "utf8").replace(FENCE, "").replace(CODE_SPAN, "")
	return [...text.matchAll(INLINE), ...text.matchAll(REFERENCE)].map((m) => m[1])
}

test("resolveLink skips URLs and anchors and resolves the rest from the doc's directory", () => {
	expect(resolveLink("apps/tools/README.md", "https://example.com/a")).toBeNull()
	expect(resolveLink("apps/tools/README.md", "#quick-start")).toBeNull()
	expect(resolveLink("apps/tools/README.md", "../../AGENTS.md#plans")).toBe("AGENTS.md")
	expect(resolveLink("apps/tools/README.md", "./tests/browser/")).toBe("apps/tools/tests/browser")
	expect(resolveLink("README.md", "/UPDATE.md")).toBe("UPDATE.md")
	expect(resolveLink("README.md", "a%20b.md")).toBe("a b.md")
})

test("every relative link in an operational doc resolves", () => {
	const docs = files.filter(operational)
	const found = docs.flatMap((doc) => links(doc).map((target) => ({ doc, target, path: resolveLink(doc, target) })))
	const relative = found.filter((l) => l.path !== null)
	expect(docs).toContain("AGENTS.md")
	expect(relative.length).toBeGreaterThan(40)
	expect(relative.filter((l) => !paths.has(l.path as string)).map((l) => `${l.doc}: ${l.target}`)).toEqual([])
})

test("CLAUDE.md's imports resolve", () => {
	const imports = readFileSync(join(ROOT, "CLAUDE.md"), "utf8").match(/^@\S+/gm) ?? []
	expect(imports).toContain("@AGENTS.md")
	expect(imports.filter((i) => !paths.has(i.slice(1)))).toEqual([])
})
