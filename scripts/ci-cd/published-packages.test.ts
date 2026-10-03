import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * The three packages the wallet repository publishes run against the consumer's own `@aztec-labs/*`
 * install, as peers. Each dependent must declare every peer itself at exactly the peer's pin: a
 * drifted pin installs a second copy, and two `Fr` classes fail at runtime, not at install.
 */
const ROOT = join(import.meta.dir, "..", "..")
const EXACT = /^\d+\.\d+\.\d+(?:-[\w.]+)?$/

const CONSUMERS: Record<string, string[]> = {
	"apps/tools": [
		"@alejoamiras/nulo-resolve-asset",
		"@alejoamiras/nulo-wallet-crypto",
		"@alejoamiras/nulo-wallet-sdk-schema-patch",
	],
	"packages/bridge-core": ["@alejoamiras/nulo-resolve-asset", "@alejoamiras/nulo-wallet-crypto"],
}
const PEERS: Record<string, string[]> = {
	"@alejoamiras/nulo-resolve-asset": [],
	"@alejoamiras/nulo-wallet-crypto": ["@aztec-labs/accounts", "@aztec-labs/foundation"],
	"@alejoamiras/nulo-wallet-sdk-schema-patch": ["@aztec-labs/aztec.js", "@aztec-labs/stdlib"],
}

type Deps = Record<string, string>
const lock = Bun.JSONC.parse(readFileSync(join(ROOT, "bun.lock"), "utf8")) as {
	workspaces: Record<string, { dependencies?: Deps; devDependencies?: Deps }>
	packages: Record<string, [string, string, { peerDependencies?: Deps }, string]>
}
const declaredBy = (path: string): Deps => ({ ...lock.workspaces[path]?.dependencies, ...lock.workspaces[path]?.devDependencies })

test("exactly the expected workspaces depend on the published packages", () => {
	const found = Object.keys(lock.workspaces)
		.map((path) => [path, Object.keys(declaredBy(path)).filter((name) => Object.hasOwn(PEERS, name)).sort()] as const)
		.filter(([, names]) => names.length > 0)
	expect(Object.fromEntries(found)).toEqual(CONSUMERS)
})

test("each is an exact pin whose peers its dependent declares at the same pin", () => {
	for (const [path, names] of Object.entries(CONSUMERS)) {
		const declared = declaredBy(path)
		for (const name of names) {
			expect(declared[name], `${path}: ${name}`).toMatch(EXACT)
			const [resolved, , meta] = lock.packages[name]
			expect(resolved, `${path}: ${name} resolves to its pin`).toBe(`${name}@${declared[name]}`)
			const peers = meta.peerDependencies ?? {}
			expect(Object.keys(peers).sort(), `${name}'s peers`).toEqual(PEERS[name])
			for (const [peer, pin] of Object.entries(peers)) {
				expect(pin, `${name}'s ${peer} peer`).toMatch(EXACT)
				expect(declared[peer], `${path} declares ${peer} as ${name} pins it`).toBe(pin)
			}
		}
	}
})
