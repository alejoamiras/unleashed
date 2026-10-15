import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { loadContractArtifact } from "@aztec-labs/stdlib/abi"
import { getContractClassFromArtifact } from "@aztec-labs/stdlib/contract"
import { DripperContractArtifact } from "@aztec-foundation/aztec-standards/artifacts/src/artifacts/Dripper.js"
import { TokenContractArtifact } from "@aztec-foundation/aztec-standards/artifacts/src/artifacts/Token.js"
import { describe, expect, it } from "vitest"

/**
 * Supply-chain tripwire: each committed bridge artifact must derive its pinned class id (bytecode + ABI, the
 * on-chain identity) and self-report the pinned toolchain. Re-pin only after `contracts/bridge/aztec/scripts/compile.sh`
 * rebuilds it on that toolchain; CI's `compile.sh --check` proves source parity.
 */

const here = dirname(fileURLToPath(import.meta.url))
const CONTRACTS = join(here, "..", "..", "..", "contracts", "bridge", "aztec")

const PINS = [
	{
		// The any-ERC-20 hub. Source parity with this artifact is checked by
		// `contracts/bridge/aztec/scripts/compile.sh --check` (a rebuild must derive this id).
		name: "TokenBridgeHub",
		path: join(CONTRACTS, "token_bridge_hub", "target", "token_bridge_hub_contract-TokenBridgeHub.json"),
		classId: "0x198c190c4eb3f1522cad4802d001d444724358732dc01710203657f9aeafd124",
	},
] as const

describe("committed bridge Noir artifacts — class-id tripwire (6.0.0-rc.3)", () => {
	for (const pin of PINS) {
		it(`${pin.name} derives its pinned class id`, async () => {
			const artifact = loadContractArtifact(JSON.parse(readFileSync(pin.path, "utf8")))
			const cls = await getContractClassFromArtifact(artifact)
			expect(cls.id.toString()).toBe(pin.classId)
		})
	}

	it("every artifact self-reports aztec_version 6.0.0-rc.3", () => {
		for (const pin of PINS) {
			const raw = JSON.parse(readFileSync(pin.path, "utf8")) as { aztecVersion?: string; aztec_version?: string }
			expect(raw.aztecVersion ?? raw.aztec_version).toBe("6.0.0-rc.3")
		}
	})
})

/**
 * Standards package tripwire: the lockfile byte-pins
 * `@aztec-foundation/aztec-standards` by SHA-512, but a lock regeneration accepts new
 * integrity, and `descriptors-real-artifact.test.ts` only checks ABI shape (a
 * bytecode-tampered artifact retaining its ABI passes). Pinning the DERIVED class ids
 * of the runtime-loaded Token + Dripper artifacts binds their on-chain IDENTITY — the
 * wallet, tools, and bridge all register instances from these exact bytes.
 */
describe("installed aztec-standards Token/Dripper — class-id tripwire (6.0.0-rc.3)", () => {
	const STANDARDS = [
		{ name: "Token", artifact: TokenContractArtifact, classId: "0x163b2b247391083157f9fc30405e81810e6c08c58501fa2dd10de27d42be1d8a" },
		{
			name: "Dripper",
			artifact: DripperContractArtifact,
			classId: "0x0f4534726aabce58c1e4089bcf50215c60cd2e2a598e47a2e1d549f9897f53f1",
		},
	] as const
	for (const std of STANDARDS) {
		it(`${std.name} derives its pinned class id`, async () => {
			const cls = await getContractClassFromArtifact(loadContractArtifact(std.artifact as never))
			expect(cls.id.toString()).toBe(std.classId)
		})
	}
})
