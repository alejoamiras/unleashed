import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { PORTAL_FACTORY_ABI, TOKEN_PORTAL_ABI } from "./factory-abi"

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "contracts", "bridge", "evm", "out")
const FACTORY_ARTIFACT = join(OUT, "PortalFactory.sol", "PortalFactory.json")
const PORTAL_ARTIFACT = join(OUT, "TokenPortalImpl.sol", "TokenPortalImpl.json")

type AbiParam = { name: string; type: string; indexed?: boolean; components?: AbiParam[] }
type AbiEntry = { type: string; name?: string; stateMutability?: string; inputs?: AbiParam[]; outputs?: AbiParam[] }

const shape = (p: AbiParam): unknown => ({
	name: p.name,
	type: p.type,
	...(p.indexed !== undefined ? { indexed: p.indexed } : {}),
	...(p.components ? { components: p.components.map(shape) } : {}),
})
const entryShape = (e: AbiEntry): unknown => ({
	type: e.type,
	name: e.name,
	...(e.stateMutability ? { stateMutability: e.stateMutability } : {}),
	inputs: (e.inputs ?? []).map(shape),
	...(e.outputs ? { outputs: e.outputs.map(shape) } : {}),
})

// Lazy artifact reads (inside each `it`): `skipIf` still runs the describe factory at collection
// time, and forge's `out/` is absent wherever contracts aren't compiled (CI's unit-test job).
const loadAbi = (path: string) => (JSON.parse(readFileSync(path, "utf8")) as { abi: AbiEntry[] }).abi

/** Every entry of the hand-written const must equal the compiled entry of the same type + name. */
function expectPinned(ours: readonly AbiEntry[], artifactPath: string) {
	const real = loadAbi(artifactPath)
	for (const entry of ours) {
		const match = real.find((r) => r.type === entry.type && r.name === entry.name)
		expect(match, `${entry.type} ${entry.name} missing from ${artifactPath}`).toBeDefined()
		expect(entryShape(entry)).toEqual(entryShape(match as AbiEntry))
	}
}

describe.skipIf(!existsSync(FACTORY_ARTIFACT) || !existsSync(PORTAL_ARTIFACT))("factory-abi pin (forge artifacts)", () => {
	it("PORTAL_FACTORY_ABI matches the compiled PortalFactory", () => {
		expectPinned(PORTAL_FACTORY_ABI as unknown as readonly AbiEntry[], FACTORY_ARTIFACT)
	})

	it("TOKEN_PORTAL_ABI matches the compiled TokenPortalImpl", () => {
		expectPinned(TOKEN_PORTAL_ABI as unknown as readonly AbiEntry[], PORTAL_ARTIFACT)
	})
})
