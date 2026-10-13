import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const ROOT = join(import.meta.dir, "..", "..")
const read = (path: string) => JSON.parse(readFileSync(join(ROOT, path), "utf8"))
const root = read("package.json")

const workspaces: string[] = root.workspaces
	.flatMap((pattern: string) => [...new Bun.Glob(`${pattern}/package.json`).scanSync({ cwd: ROOT })])
	.map((manifest: string) => read(manifest).name)
	.sort()

// A filter that matches no workspace makes `bun run --filter` exit 0 having run nothing.
test("the all-workspace scripts select every workspace", () => {
	expect(workspaces).toEqual(["@unleashed/bridge-core", "@unleashed/design", "@unleashed/landing", "@unleashed/tools"])
	for (const script of ["typecheck:all", "test:all"]) {
		const filter = root.scripts[script].match(/--filter '([^']+)'/)?.[1]
		expect(filter, script).toBeDefined()
		const glob = new Bun.Glob(filter)
		expect(
			workspaces.filter((name) => glob.match(name)),
			script,
		).toEqual(workspaces)
	}
})
