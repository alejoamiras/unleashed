import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"

// A static import or re-export (its `from` closes a line starting `import`, `export` or `}`), a bare
// `import "…"`, or a dynamic `import("…")`: string literals elsewhere never match.
const SPECIFIER = /^(?:(?:import|export|\})[^\n"]*\bfrom\s+|import\s+)"([^"]+)"|\bimport\(\s*"([^"]+)"\s*\)/gm

const specifiersIn = (file: string): string[] =>
	[...readFileSync(file, "utf8").matchAll(SPECIFIER)].map(([, fixed, dynamic]) => fixed ?? dynamic ?? "")

const resolved = (from: string, spec: string) => join(dirname(from), spec.endsWith(".ts") ? spec : `${spec}.ts`)

/** Every package specifier `entry` reaches through its relative imports, type-only ones included. */
function packagesReached(entry: string): Set<string> {
	const packages = new Set<string>()
	const seen = new Set<string>()
	const pending = [entry]
	for (let file = pending.pop(); file; file = pending.pop()) {
		if (seen.has(file)) continue
		seen.add(file)
		const specs = specifiersIn(file)
		for (const spec of specs.filter((s) => !s.startsWith("."))) packages.add(spec)
		pending.push(...specs.filter((s) => s.startsWith(".")).map((s) => resolved(file as string, s)))
	}
	return packages
}

const here = (name: string) => join(dirname(fileURLToPath(import.meta.url)), name)

// The testnet relayer Worker bundles this entry: one `node:` builtin or Aztec package anywhere below it fails there.
it("reaches viem and nothing else", () => {
	const reached = packagesReached(here("across-fill.ts"))
	expect([...reached].filter((p) => p !== "viem" && !p.startsWith("viem/"))).toEqual([])
	expect(reached).toContain("viem")
	expect([...packagesReached(here("crosschain-discovery.ts"))].some((p) => p.startsWith("@aztec"))).toBe(true)
})
