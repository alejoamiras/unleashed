import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { deriveHubTokenInstance } from "../src/hub-token"
import type { ManifestV2 } from "../src/manifest-v2"
import { predictPortal } from "../src/portal-address"
import { openDeployJournal, readCandidate, readDeployJournal, writeCandidateAtomically } from "./deploy-manifest"

let dir: string
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "deploy-manifest-"))
})
afterEach(() => {
	rmSync(dir, { recursive: true, force: true })
})

const FACTORY = "0x3333333333333333333333333333333333333333"
const IMPL = "0x1111111111111111111111111111111111111111"
const ERC20 = "0x00000000000000000000000000000000000e2c20"
const HUB = "0x1234000000000000000000000000000000000000000000000000000000000abc"
const GUARDIAN = `0x${"0".repeat(61)}ab1`
const TOKEN_CLASS_ID = "0x24c34002788720c941a327a20c369b12c8bdcff3b5a974673a8f618763471505"
const NAME_WORD = "0x005465737420546f6b656e000000000000000000000000000000000000000000"
const SYMBOL_WORD = "0x0054535400000000000000000000000000000000000000000000000000000000"
const FEE_PORTAL = "0xb4a9f8eadc8ca944729d61e59a9f491faff237a3"
const TX = `0x${"ab".repeat(32)}`

/** A network with no bridge — a legal manifest, and the smallest thing the writer must accept. */
const placeholder: ManifestV2 = {
	schema: 2,
	network: "mainnet",
	l1ChainId: 1,
	walletChainId: 1,
	bridge: null,
	feeJuice: { portal: FEE_PORTAL, asset: "0x762c132040fda6183066fa3b14d985ee55aa3c18", minFj: "16000000000000000000" },
	privateClaimMode: "salt-v2",
}

async function withBridge(): Promise<ManifestV2> {
	const l2Token = await deriveHubTokenInstance(
		AztecAddress.fromStringUnsafe(HUB),
		ERC20,
		{ nameWord: NAME_WORD, symbolWord: SYMBOL_WORD, decimals: 18 },
		TOKEN_CLASS_ID,
	)
	return {
		...placeholder,
		network: "sandbox",
		l1ChainId: 31337,
		walletChainId: 31337,
		bridge: {
			l1: {
				registry: "0x0000000000000000000000000000000000000001",
				factory: FACTORY,
				implementation: IMPL,
				guardian: "0x0000000000000000000000000000000000000002",
				permit2: "0x000000000022d473030f116ddee9f6b43ac78ba3",
				feeJuicePortal: FEE_PORTAL,
			},
			l2: {
				hub: {
					address: HUB,
					salt: `0x${"0".repeat(24)}${FACTORY.slice(2)}`,
					constructorArtifact: "constructor",
					constructorArgs: [TOKEN_CLASS_ID, FACTORY, GUARDIAN],
				},
				guardian: GUARDIAN,
				tokenClassId: TOKEN_CLASS_ID,
				tokenArtifactSha256: "a".repeat(64),
			},
			tokens: [
				{
					erc20: ERC20,
					portal: predictPortal(FACTORY, IMPL, ERC20),
					l2Token: l2Token.address.toString(),
					nameWord: NAME_WORD,
					symbolWord: SYMBOL_WORD,
					decimals: 18,
					displayName: "Test Token",
					displaySymbol: "TST",
					source: "permissionless-mint",
					sourceContract: "TestUsdc",
					maxWholePerTx: 1000,
				},
			],
		},
	}
}

describe("writeCandidateAtomically", () => {
	it("round-trips a bridge manifest and leaves no temp file", async () => {
		const manifest = await withBridge()
		const target = join(dir, "sandbox-bridge.candidate.json")
		writeCandidateAtomically(target, manifest)

		expect(JSON.parse(readFileSync(target, "utf8"))).toEqual(manifest)
		expect(readCandidate(target)).toEqual(manifest)
		expect(readCandidate(join(dir, "absent.json"))).toBeUndefined()
		expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toHaveLength(0)
	})

	it("accepts a placeholder network and overwrites an existing candidate atomically", () => {
		const target = join(dir, "c.json")
		writeCandidateAtomically(target, placeholder)
		writeCandidateAtomically(target, { ...placeholder, network: "mainnet-2" })
		expect(readCandidate(target)?.network).toBe("mainnet-2")
	})

	it("refuses an invalid manifest before anything reaches disk", async () => {
		const manifest = await withBridge()
		const target = join(dir, "bad.json")
		const bridge = manifest.bridge
		if (!bridge) throw new Error("fixture must carry a bridge")

		expect(() =>
			writeCandidateAtomically(target, {
				...manifest,
				bridge: { ...bridge, tokens: [{ ...bridge.tokens[0], portal: "0x00000000000000000000000000000000000000ee" }] },
			}),
		).toThrow(/portal is not the factory's CREATE2/)
		// Validation runs before the temp file is created, so a refused write leaves the directory clean.
		expect(readdirSync(dir)).toEqual([])
	})
})

describe("deploy journal", () => {
	it("appends steps, reads them back in order, and resumes per-token work by key", () => {
		const path = join(dir, "journal", "deploy.jsonl")
		const journal = openDeployJournal(path)
		expect(journal.steps).toEqual([])

		journal.append({ kind: "classes-published", tokenClassId: TOKEN_CLASS_ID, hubClassId: `0x${"cc".repeat(32)}` })
		journal.append({ kind: "factory-predicted", factory: FACTORY, implementation: IMPL })
		journal.append({ kind: "factory-deployed", factory: FACTORY, implementation: IMPL, txHash: TX })
		journal.append({ kind: "token-precreated", erc20: ERC20, portal: predictPortal(FACTORY, IMPL, ERC20), txHash: TX })

		expect(journal.steps.map((s) => s.kind)).toEqual(["classes-published", "factory-predicted", "factory-deployed", "token-precreated"])
		expect(journal.has("hub-deployed")).toBe(false)
		expect(journal.has("token-precreated", ERC20.toUpperCase().replace("0X", "0x"))).toBe(true)
		expect(journal.has("token-precreated", "0x0000000000000000000000000000000000000009")).toBe(false)
		expect(journal.has("pool-seeded", ERC20)).toBe(false)

		// A fresh reader sees exactly the same history — the journal, not memory, is the resume authority.
		const resumed = openDeployJournal(path)
		expect(resumed.steps).toEqual(journal.steps)
		expect(resumed.has("factory-deployed")).toBe(true)
	})

	it("stamps the live network once and refuses a resume against another one", () => {
		const path = join(dir, "identity.jsonl")
		const identity = {
			l1ChainId: 11155111,
			rollupVersion: 4,
			deployer: "0x7777777777777777777777777777777777777777",
			registry: "0x0000000000000000000000000000000000000001",
			feeJuicePortal: FEE_PORTAL,
		}
		const journal = openDeployJournal(path, identity)
		expect(journal.steps).toEqual([{ kind: "identity", ...identity }])
		journal.append({ kind: "factory-predicted", factory: FACTORY, implementation: IMPL })

		// The same network re-opens the journal and resumes; a second stamp is never written.
		const resumed = openDeployJournal(path, identity)
		expect(resumed.steps.filter((s) => s.kind === "identity")).toHaveLength(1)
		expect(resumed.has("factory-predicted")).toBe(true)

		// A moved rollup means the recorded factory and hub belong to a chain that no longer exists.
		expect(() => openDeployJournal(path, { ...identity, rollupVersion: 5 })).toThrow(/rollupVersion is 4, the live network says 5/)
		expect(() => openDeployJournal(path, { ...identity, deployer: IMPL })).toThrow(/deployer is/)
	})

	it("refuses a journal that predates identity stamping", () => {
		const path = join(dir, "unstamped.jsonl")
		openDeployJournal(path).append({ kind: "factory-predicted", factory: FACTORY, implementation: IMPL })
		expect(() =>
			openDeployJournal(path, {
				l1ChainId: 31337,
				rollupVersion: 1,
				deployer: FACTORY,
				registry: IMPL,
				feeJuicePortal: FEE_PORTAL,
			}),
		).toThrow(/predates identity stamping/)
	})

	it("a journal written before the router-only kinds still parses beside them, and both new kinds carry their adoption keys", () => {
		const path = join(dir, "old.jsonl")
		const line = (step: object) => `${JSON.stringify({ ts: "then", step })}\n`
		const adoptable = (kind: string) => ({
			kind,
			address: FACTORY,
			txHash: TX,
			creationCodeHash: `0x${"cd".repeat(32)}`,
			constructorArgs: [IMPL, FEE_PORTAL],
		})
		writeFileSync(
			path,
			[
				line({ kind: "swap-target-deployed", address: IMPL, txHash: TX }),
				line({ kind: "router-deployed", router: FACTORY, txHash: TX }),
				line({ kind: "pool-seeded", erc20: ERC20, txHash: TX }),
				line({ kind: "pool-seeded", erc20: IMPL }),
				line(adoptable("fuel-swapper-deployed")),
				line(adoptable("deposit-router-deployed")),
			].join(""),
		)
		expect(readDeployJournal(path).map((s) => s.kind)).toEqual([
			"swap-target-deployed",
			"router-deployed",
			"pool-seeded",
			"pool-seeded",
			"fuel-swapper-deployed",
			"deposit-router-deployed",
		])
		// The live generation's own journal, as committed, is an old journal too.
		const committed = readDeployJournal(join(import.meta.dirname, "..", "deploy-journal", "testnet-generation.jsonl"))
		expect(committed.map((s) => s.kind)).toContain("swap-target-deployed")

		// Without the constructor arguments a re-run could not tell an identical contract from a changed one.
		const { constructorArgs: _, ...keyless } = adoptable("deposit-router-deployed")
		writeFileSync(path, line(keyless))
		expect(() => readDeployJournal(path)).toThrow(/entry 1 is not a valid step/)
	})

	it("rejects a journal line that is not a valid step", () => {
		const path = join(dir, "garbage.jsonl")
		writeFileSync(path, `${JSON.stringify({ ts: "now", step: { kind: "factory-deployed", factory: FACTORY } })}\n`)
		expect(() => readDeployJournal(path)).toThrow(/entry 1 is not a valid step/)

		writeFileSync(path, "{not json\n")
		expect(() => readDeployJournal(path)).toThrow(/entry 1 is not JSON/)

		writeFileSync(path, `${JSON.stringify({ ts: "now", step: { kind: "who-knows" } })}\n`)
		expect(() => readDeployJournal(path)).toThrow(/entry 1 is not a valid step/)
	})
})
