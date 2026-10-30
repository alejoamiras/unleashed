import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { type AbiEntry, missingFrom } from "./abi-shape.ts"
import { PORTAL_FACTORY_ABI, TOKEN_PORTAL_ABI } from "./factory-abi.ts"

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "contracts", "bridge", "evm", "out")
const FACTORY_ARTIFACT = join(OUT, "PortalFactory.sol", "PortalFactory.json")
const PORTAL_ARTIFACT = join(OUT, "TokenPortalImpl.sol", "TokenPortalImpl.json")

// Lazy artifact reads (inside each `it`): `skipIf` still runs the describe factory at collection
// time, and forge's `out/` is absent wherever contracts aren't compiled (CI's unit-test job).
const loadAbi = (path: string) => (JSON.parse(readFileSync(path, "utf8")) as { abi: AbiEntry[] }).abi

/** Every entry of the hand-written const must equal a compiled entry. */
function expectPinned(ours: readonly AbiEntry[], artifactPath: string) {
	expect(missingFrom(ours, loadAbi(artifactPath))).toEqual([])
}

describe.skipIf(!existsSync(FACTORY_ARTIFACT) || !existsSync(PORTAL_ARTIFACT))("factory-abi pin (forge artifacts)", () => {
	it("PORTAL_FACTORY_ABI matches the compiled PortalFactory", () => {
		expectPinned(PORTAL_FACTORY_ABI as unknown as readonly AbiEntry[], FACTORY_ARTIFACT)
	})

	it("TOKEN_PORTAL_ABI matches the compiled TokenPortalImpl", () => {
		expectPinned(TOKEN_PORTAL_ABI as unknown as readonly AbiEntry[], PORTAL_ARTIFACT)
	})
})
