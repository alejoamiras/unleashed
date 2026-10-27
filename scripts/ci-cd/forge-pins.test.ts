import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/** A contributor's `forge install` from the README resolves the same library commits CI builds and caches. */
const ROOT = join(import.meta.dir, "..", "..")
const PIN = /\b[\w.-]+\/[\w.-]+@(?:rev=)?[0-9a-f]{40}\b/g

test("the contracts README pins the forge libraries setup-forge installs", () => {
	// biome-ignore lint/suspicious/noExplicitAny: parsed-YAML shape is dynamic.
	const action = Bun.YAML.parse(readFileSync(join(ROOT, ".github/actions/setup-forge/action.yml"), "utf8")) as any
	const install: string = action.runs.steps.find((s: { name?: string }) => s.name === "Install forge libraries").run
	const readme = readFileSync(join(ROOT, "contracts/bridge/evm/README.md"), "utf8")
	const ci = install.match(PIN) ?? []
	expect(ci).toHaveLength(3)
	expect((readme.match(/forge install[^`]*/)?.[0].match(PIN) ?? []).sort()).toEqual([...ci].sort())
})
