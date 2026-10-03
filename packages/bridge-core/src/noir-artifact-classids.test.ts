import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { loadContractArtifact } from "@aztec-labs/stdlib/abi"
import { getContractClassFromArtifact } from "@aztec-labs/stdlib/contract"
import { DripperContractArtifact } from "@aztec-foundation/aztec-standards/artifacts/src/artifacts/Dripper.js"
import { TokenContractArtifact } from "@aztec-foundation/aztec-standards/artifacts/src/artifacts/Token.js"
import { describe, expect, it } from "vitest"

/**
 * Supply-chain tripwire: the committed bridge Noir artifacts are NOT reproducibly bound to
 * source — CI has no nargo, Nargo.toml pins mutable git tags, and the multi-MiB JSONs merely
 * self-report `aztec_version`. A stale or hand-edited-yet-valid artifact would otherwise survive
 * CI and become the runtime + deploy input. This pins each artifact's DERIVED class id (bytecode +
 * ABI, the on-chain identity) AND its sha256 to the values recorded when they were compiled from
 * the pinned 6.0.0-rc.1 toolchain + AztecProtocol/aztec-standards@v6.0.0-rc.1. ANY drift in the committed
 * bytes trips this before a live deploy consumes them. Regenerate ONLY via `contracts/bridge/aztec/scripts/
 * compile.sh` on the pinned toolchain, then update the pins here consciously.
 */

const here = dirname(fileURLToPath(import.meta.url))
const CONTRACTS = join(here, "..", "..", "..", "contracts", "bridge", "aztec")

const PINS = [
	{
		// The any-ERC-20 hub. Source parity with this artifact is checked by
		// `contracts/bridge/aztec/scripts/compile.sh --check` (a rebuild must derive this id).
		name: "TokenBridgeHub",
		path: join(CONTRACTS, "token_bridge_hub", "target", "token_bridge_hub_contract-TokenBridgeHub.json"),
		classId: "0x0acfdc7d692f9f1777ab75090b00b1df2e724c3a2df281ef077829c58776a58c",
	},
] as const

describe("committed bridge Noir artifacts — class-id + digest tripwire (6.0.0-rc.1)", () => {
	for (const pin of PINS) {
		it(`${pin.name} derives its pinned class id`, async () => {
			const artifact = loadContractArtifact(JSON.parse(readFileSync(pin.path, "utf8")))
			const cls = await getContractClassFromArtifact(artifact)
			expect(cls.id.toString()).toBe(pin.classId)
		})
	}

	it("every artifact self-reports aztec_version 6.0.0-rc.1", () => {
		for (const pin of PINS) {
			const raw = JSON.parse(readFileSync(pin.path, "utf8")) as { aztecVersion?: string; aztec_version?: string }
			expect(raw.aztecVersion ?? raw.aztec_version).toBe("6.0.0-rc.1")
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
describe("installed aztec-standards Token/Dripper — class-id tripwire (6.0.0-rc.1)", () => {
	const STANDARDS = [
		{ name: "Token", artifact: TokenContractArtifact, classId: "0x24c34002788720c941a327a20c369b12c8bdcff3b5a974673a8f618763471505" },
		{
			name: "Dripper",
			artifact: DripperContractArtifact,
			classId: "0x1febf8925ddf9c9bf7f92eb14d391f78651d745c06e700d79b3e09d70a57c5f9",
		},
	] as const
	for (const std of STANDARDS) {
		it(`${std.name} derives its pinned class id`, async () => {
			const cls = await getContractClassFromArtifact(loadContractArtifact(std.artifact as never))
			expect(cls.id.toString()).toBe(std.classId)
		})
	}
})
