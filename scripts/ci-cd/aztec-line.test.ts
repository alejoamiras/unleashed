import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * One Aztec generation per install. Every resolved `@aztec-labs/*` and `@aztec-foundation/*`
 * package sits at the `@aztec-labs/aztec.js` pin, and nothing resolves under the retired `@aztec/*`
 * scope except `@aztec/viem`, which the Aztec packages alias as their own viem. A second generation
 * in the tree means two `Fr` classes, which fail at runtime rather than at install. The TXE server's
 * lockfile is checked too: its oracle must speak the line the contracts compile against.
 */
const ROOT = join(import.meta.dir, "..", "..")
const LOCKFILES = ["bun.lock", "contracts/bridge/aztec/txe-server/bun.lock"]
const PIN_SOURCES = ["packages/bridge-core/package.json", "apps/tools/package.json"]

const pinOf = (path: string): string | undefined =>
	(JSON.parse(readFileSync(join(ROOT, path), "utf8")) as { dependencies?: Record<string, string> }).dependencies?.[
		"@aztec-labs/aztec.js"
	]
const PIN = pinOf(PIN_SOURCES[0])

/** `name@version` identities of every package a lockfile resolves. */
function resolved(lockfile: string): { name: string; version: string }[] {
	const lock = Bun.JSONC.parse(readFileSync(join(ROOT, lockfile), "utf8")) as { packages: Record<string, [string, ...unknown[]]> }
	return Object.values(lock.packages).map(([id]) => {
		const at = id.lastIndexOf("@")
		return { name: id.slice(0, at), version: id.slice(at + 1) }
	})
}

test("every workspace the CI pin readers consult names the same exact Aztec pin", () => {
	expect(PIN).toMatch(/^\d+\.\d+\.\d+(?:-[\w.]+)?$/)
	for (const path of PIN_SOURCES) expect(pinOf(path), path).toBe(PIN)
})

test.each(LOCKFILES)("%s resolves a single Aztec generation", (lockfile) => {
	const strays = resolved(lockfile)
		.filter(({ name, version }) =>
			name.startsWith("@aztec/") ? name !== "@aztec/viem" : /^@aztec-(labs|foundation)\//.test(name) && version !== PIN,
		)
		.map(({ name, version }) => `${name}@${version}`)
	expect(strays).toEqual([])
})
