import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"

// A static import or re-export (its `from` closes a line starting `import`, `export` or `}`), a bare
// `import "…"`, or a dynamic `import("…")`: string literals elsewhere never match.
const SPECIFIER = /^(?:(?:import|export|\})[^\n"]*\bfrom\s+|import\s+)"([^"]+)"|\bimport\(\s*"([^"]+)"\s*\)/gm

const specifiersIn = (file: string): string[] =>
	[...readFileSync(file, "utf8").matchAll(SPECIFIER)].map(([, fixed, dynamic]) => fixed ?? dynamic ?? "")

const resolved = (from: string, spec: string) => join(dirname(from), /\.(ts|json)$/.test(spec) ? spec : `${spec}.ts`)

const here = (name: string) => join(dirname(fileURLToPath(import.meta.url)), name)

const SDK_SRC = here("../../sdk/src")
/** A bundler resolves every member of a barrel it imports, used or not. */
const SDK_ENTRIES: Record<string, string> = {
	"@unleashed/sdk": "index.ts",
	"@unleashed/sdk/protocol": "protocol/index.ts",
	"@unleashed/sdk/l1": "l1.ts",
	"@unleashed/sdk/internal": "internal.ts",
}

/** Every package specifier `entry` reaches through its relative imports and the SDK entries it imports, type-only
 *  ones included. */
function packagesReached(entry: string): Set<string> {
	const packages = new Set<string>()
	const seen = new Set<string>()
	const pending = [entry]
	for (let file = pending.pop(); file; file = pending.pop()) {
		if (seen.has(file) || file.endsWith(".json")) continue
		seen.add(file)
		const specs = specifiersIn(file)
		for (const spec of specs.filter((s) => !s.startsWith(".") && !s.startsWith("@unleashed/sdk"))) packages.add(spec)
		const sdk = specs.filter((s) => s.startsWith("@unleashed/sdk")).map((s) => join(SDK_SRC, SDK_ENTRIES[s] ?? `unknown entry ${s}`))
		pending.push(...specs.filter((s) => s.startsWith(".")).map((s) => resolved(file as string, s)), ...sdk)
	}
	return packages
}

// The testnet relayer Worker bundles this entry: one `node:` builtin or Aztec package anywhere below it fails there.
it("reaches viem and nothing else", () => {
	const reached = packagesReached(here("across-fill.ts"))
	expect([...reached].filter((p) => p !== "viem" && !p.startsWith("viem/"))).toEqual([])
	expect(reached).toContain("viem")
	expect([...packagesReached(here("crosschain-discovery.ts"))].some((p) => p.startsWith("@aztec"))).toBe(true)
})
