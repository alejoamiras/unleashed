import { expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * One Aztec line per install. The line publishes on two version tracks: every `@aztec-labs/*`
 * package sits at the `@aztec-labs/aztec.js` pin, and every `@aztec-foundation/*` package at the
 * version that aztec.js itself depends on, read from the lockfile so the next line needs no edit.
 * `@aztec-foundation/aztec-standards` follows the standards repository's own tags and sits at its
 * declared pin. Nothing resolves under the retired `@aztec/*` scope except `@aztec/viem`, which the
 * Aztec packages alias as their own viem. A second version in the tree means two `Fr` classes, which
 * fail at runtime rather than at install. The TXE server's lockfile is checked too: its oracle must
 * speak the line the contracts compile against.
 */
const ROOT = join(import.meta.dir, "..", "..")
const LOCKFILES = ["bun.lock", "contracts/bridge/aztec/txe-server/bun.lock"]
const PIN_SOURCES = ["packages/bridge-core/package.json", "apps/tools/package.json"]
const EXACT = /^\d+\.\d+\.\d+(?:-[\w.]+)?$/
const STANDARDS = "@aztec-foundation/aztec-standards"

type Specs = Record<string, string>
type Manifest = {
	workspaces?: string[]
	dependencies?: Specs
	devDependencies?: Specs
	peerDependencies?: Specs
	patchedDependencies?: Specs
}
type Lock = { packages: Record<string, [string, string, { dependencies?: Record<string, string> }?, string?]> }

const manifest = (path: string): Manifest => JSON.parse(readFileSync(join(ROOT, path), "utf8")) as Manifest
const lockOf = (path: string): Lock => Bun.JSONC.parse(readFileSync(join(ROOT, path), "utf8")) as Lock
const pinOf = (path: string, name: string): string | undefined => manifest(path).dependencies?.[name]

const LABS = pinOf(PIN_SOURCES[0], "@aztec-labs/aztec.js")
const STANDARDS_PIN = pinOf(PIN_SOURCES[0], STANDARDS)
const FOUNDATION = lockOf("bun.lock").packages["@aztec-labs/aztec.js"]?.[2]?.dependencies?.["@aztec-foundation/l1-artifacts"]

/** The version a package must resolve at, or `undefined` when the line does not govern it. */
function expectedVersion(name: string): string | undefined {
	if (name === STANDARDS) return STANDARDS_PIN
	if (name.startsWith("@aztec-labs/")) return LABS
	if (name.startsWith("@aztec-foundation/")) return FOUNDATION
	return undefined
}

/** `name@version` identities of every package a lockfile resolves. */
function resolved(lockfile: string): { name: string; version: string }[] {
	return Object.values(lockOf(lockfile).packages).map(([id]) => {
		const at = id.lastIndexOf("@")
		return { name: id.slice(0, at), version: id.slice(at + 1) }
	})
}

test("every workspace the CI pin readers consult names the same exact pins", () => {
	expect(LABS).toMatch(EXACT)
	expect(STANDARDS_PIN).toMatch(EXACT)
	for (const path of PIN_SOURCES) {
		expect(pinOf(path, "@aztec-labs/aztec.js"), path).toBe(LABS)
		expect(pinOf(path, STANDARDS), path).toBe(STANDARDS_PIN)
	}
})

test("every manifest declares each Aztec package at exactly its line version", () => {
	const workspaces = (manifest("package.json").workspaces ?? []).flatMap((glob) => [
		...new Bun.Glob(`${glob}/package.json`).scanSync({ cwd: ROOT }),
	])
	const off = ["package.json", "contracts/bridge/aztec/txe-server/package.json", ...workspaces].flatMap((path) => {
		const m = manifest(path)
		return Object.entries({ ...m.dependencies, ...m.devDependencies, ...m.peerDependencies })
			.filter(([name, spec]) => expectedVersion(name) !== undefined && spec !== expectedVersion(name))
			.map(([name, spec]) => `${path}: ${name}@${spec} (want ${expectedVersion(name)})`)
	})
	expect(workspaces.length).toBeGreaterThan(1)
	expect(off).toEqual([])
})

test("the foundation version is the exact one the locked aztec.js requires", () => {
	expect(FOUNDATION).toMatch(EXACT)
})

test.each(LOCKFILES)("%s resolves a single Aztec line", (lockfile) => {
	const strays = resolved(lockfile)
		.filter(({ name, version }) => {
			if (name.startsWith("@aztec/")) return name !== "@aztec/viem"
			const expected = expectedVersion(name)
			return expected !== undefined && version !== expected
		})
		.map(({ name, version }) => `${name}@${version} (want ${expectedVersion(name) ?? "none"})`)
	expect(strays).toEqual([])
})

test("every patched dependency names the foundation version, so its patch still applies", () => {
	const patched = Object.entries(manifest("package.json").patchedDependencies ?? {})
	expect(patched.length).toBeGreaterThan(0)
	for (const [key, file] of patched) {
		const at = key.lastIndexOf("@")
		expect(expectedVersion(key.slice(0, at)), key).toBe(FOUNDATION)
		expect(key.slice(at + 1), key).toBe(FOUNDATION)
		expect(existsSync(join(ROOT, file)), file).toBe(true)
	}
})
