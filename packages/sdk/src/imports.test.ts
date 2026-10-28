import { readdirSync, readFileSync } from "node:fs"
import { builtinModules } from "node:module"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { resolvePackageAsset } from "@nulo-sh/resolve-asset"
import { describe, expect, it } from "vitest"

const SRC = dirname(fileURLToPath(import.meta.url))
// A static import or re-export, a bare `import "…"`, or a dynamic `import("…")`.
const SPECIFIER = /^(?:(?:import|export|\})[^\n"]*\bfrom\s+|import\s+)"([^"]+)"|\bimport\(\s*"([^"]+)"\s*\)/gm
// Doc comments quote import specifiers they do not import.
const COMMENT = /\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm
const BUILTINS = new Set(builtinModules)
const manifest = JSON.parse(readFileSync(join(SRC, "..", "package.json"), "utf8"))
const DECLARED = new Set(Object.keys(manifest.dependencies))

const sources = (dir: string): string[] =>
	readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
		e.isDirectory() ? sources(join(dir, e.name)) : e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") ? [join(dir, e.name)] : [],
	)

const specifiersIn = (file: string): string[] =>
	[...readFileSync(file, "utf8").replace(COMMENT, "").matchAll(SPECIFIER)].map(([, fixed, dynamic]) => fixed ?? dynamic ?? "")
const isBuiltin = (spec: string) => spec.startsWith("node:") || BUILTINS.has(spec.split("/")[0])
const packageOf = (spec: string) =>
	spec
		.split("/")
		.slice(0, spec.startsWith("@") ? 2 : 1)
		.join("/")
const files = sources(SRC)
const shipped = files.flatMap((file) => specifiersIn(file).map((spec) => ({ at: file.slice(SRC.length + 1), spec })))

describe("the shipped source's imports", () => {
	it("scan every module, and would catch a built-in", () => {
		expect(files.length).toBeGreaterThan(30)
		expect(specifiersIn(fileURLToPath(import.meta.url)).filter(isBuiltin)).toContain("node:fs")
	})

	// The SDK runs in browsers and Workers: a Node built-in anywhere in src/ breaks every bundle that reaches it.
	it("name no Node built-in", () => {
		expect(shipped.filter(({ spec }) => isBuiltin(spec)).map(({ at, spec }) => `${at}: ${spec}`)).toEqual([])
	})

	// Under the isolated linker an undeclared package can still resolve here through the store's hoist
	// fallback, then fail in a consumer's install: declaration is the check, resolution the control.
	it("name only packages the SDK declares as runtime dependencies, each resolvable from it", () => {
		const bare = shipped.filter(({ spec }) => !spec.startsWith(".") && !isBuiltin(spec))
		expect(bare.length).toBeGreaterThan(0)
		expect(bare.filter(({ spec }) => !DECLARED.has(packageOf(spec))).map(({ at, spec }) => `${at}: ${spec}`)).toEqual([])
		for (const name of new Set(bare.map(({ spec }) => packageOf(spec))))
			expect(resolvePackageAsset(name, "package.json", { from: import.meta.url }), name).toMatch(/package\.json$/)
	})
})
