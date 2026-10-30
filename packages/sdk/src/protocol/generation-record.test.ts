import { readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { hexToBytes } from "viem"
import { describe, expect, it } from "vitest"
import { MAINNET_MANIFEST, TESTNET_MANIFEST } from "../networks.ts"
import { pinOfBuild } from "./code-hash.ts"
import {
	assertRecordBinds,
	assertRecordIntegrity,
	assertSolcShaped,
	keptEvmArtifact,
	LIVE_RECORDS,
	parseGenerationRecord,
} from "./generation-record.ts"
import { parseManifestV2 } from "./manifest-v2.ts"

const GENERATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "contracts", "bridge", "generations")
const reader = (dir: string) => (relative: string) => readFileSync(join(GENERATIONS, dir, relative))
const recordIn = (dir: string) => parseGenerationRecord(JSON.parse(reader(dir)("record.json").toString("utf8")))

// The records are the trust root a live chain is checked against: each entry must derive from the artifact kept beside
// it, and each bundled manifest must name exactly the addresses its record pins.
describe("the committed generation records", () => {
	const dirs = readdirSync(GENERATIONS).filter((d) => readdirSync(join(GENERATIONS, d)).includes("record.json"))

	it.each(dirs)("%s parses, derives from its kept artifacts and is solc-shaped", async (dir) => {
		await assertRecordIntegrity(recordIn(dir), reader(dir))
	})

	it("one per live chain, each bound by the manifest this release bundles for it", () => {
		expect(dirs).toEqual(expect.arrayContaining(["mainnet", "testnet"]))
		expect(LIVE_RECORDS.map((r) => r.l1ChainId).sort()).toEqual([1, 11155111])
		for (const raw of [TESTNET_MANIFEST, MAINNET_MANIFEST]) {
			const m = parseManifestV2(raw)
			const record = LIVE_RECORDS.find((r) => r.l1ChainId === m.l1ChainId)
			if (!record) throw new Error(`no live record for chain ${m.l1ChainId}`)
			expect(record).toEqual(recordIn(m.network))
			assertRecordBinds(record, m)
		}
	})

	it("refuse a record that names another router or drops the hub", () => {
		const m = parseManifestV2(TESTNET_MANIFEST)
		const record = recordIn("testnet")
		const elsewhere = structuredClone(record) as { evm: { DepositRouter: { address: string } } }
		elsewhere.evm.DepositRouter.address = `0x${"ba".repeat(20)}`
		expect(() => assertRecordBinds(parseGenerationRecord(elsewhere), m)).toThrow(/DepositRouter is 0xbaba/)
		const { aztec: _, ...hubless } = structuredClone(record)
		expect(() => assertRecordBinds(parseGenerationRecord(hubless), m)).toThrow(/has no hub/)
	})

	// A forged artifact can declare any immutable map; a pin taken from it then matches its own build, so only the
	// mask's shape keeps it from hiding code.
	it("refuse a mask wider than solc writes, though the pin matches its forged build", async () => {
		const kept = JSON.parse(reader("testnet")(keptEvmArtifact("DepositRouter")).toString("utf8"))
		const code = hexToBytes(kept.deployedBytecode.object)
		const genuine = pinOfBuild(code, kept.deployedBytecode.immutableReferences)
		expect(() => assertSolcShaped(genuine, code)).not.toThrow()
		const shifted = pinOfBuild(code, { "1": [{ start: (genuine.immutables[0]?.[0]?.start ?? 0) + 1, length: 32 }] })
		expect(() => assertSolcShaped(shifted, code)).toThrow(/not PUSH32 operands/)
		// A PUSH32 of a constant the build fixed, such as a slice of the witness type string.
		const operands: number[] = []
		for (let pc = 0; pc < genuine.trailerStart; ) {
			const op = code[pc] ?? 0
			if (op === 0x7f) operands.push(pc + 1)
			pc += op >= 0x60 && op <= 0x7f ? op - 0x5e : 1
		}
		const constant = operands.find((at) => code.subarray(at, at + 32).some((b) => b !== 0)) ?? 0
		expect(constant).toBeGreaterThan(0)
		const overConstant = pinOfBuild(code, { ...kept.deployedBytecode.immutableReferences, "0": [{ start: constant, length: 32 }] })
		expect(() => assertSolcShaped(overConstant, code)).toThrow(/not zero in the build/)
		const wide = { ...genuine, immutables: [[{ start: 0, length: 4096 }]] }
		expect(() =>
			parseGenerationRecord({
				...recordIn("testnet"),
				evm: { DepositRouter: { ...recordIn("testnet").evm.DepositRouter, pin: wide } },
			}),
		).toThrow(/32-byte word/)
	})
})
