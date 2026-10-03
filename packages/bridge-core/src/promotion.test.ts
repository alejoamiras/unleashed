import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { describe, expect, it } from "vitest"
import { deriveHubTokenInstance } from "./hub-token"
import { deriveManifestHub, type ManifestV2 } from "./manifest-v2"
import { predictPortal } from "./portal-address"
import { assertFaucetCandidateShape, assertZeroSeed } from "./promotion"

const FACTORY = "0x3333333333333333333333333333333333333333"
const IMPL = "0x1111111111111111111111111111111111111111"
const ERC20 = "0x00000000000000000000000000000000000e2c20"
const GUARDIAN = "0x0000000000000000000000000000000000000000000000000000000000000ab1"
const TOKEN_CLASS_ID = "0x24c34002788720c941a327a20c369b12c8bdcff3b5a974673a8f618763471505"
const FEE_PORTAL = "0xb4a9f8eadc8ca944729d61e59a9f491faff237a3"
const HUB_RECORD = {
	salt: `0x${"0".repeat(24)}${FACTORY.slice(2)}`,
	constructorArtifact: "constructor",
	constructorArgs: [TOKEN_CLASS_ID, FACTORY, GUARDIAN],
}
const HUB = (
	await deriveManifestHub({ l2: { hub: { ...HUB_RECORD, address: "" } } } as unknown as Parameters<typeof deriveManifestHub>[0])
).address.toString()

const NAME_WORD = "0x005465737420546f6b656e000000000000000000000000000000000000000000"
const SYMBOL_WORD = "0x0054535400000000000000000000000000000000000000000000000000000000"
const L2_TOKEN = (
	await deriveHubTokenInstance(
		AztecAddress.fromStringUnsafe(HUB),
		ERC20,
		{ nameWord: NAME_WORD, symbolWord: SYMBOL_WORD, decimals: 18 },
		TOKEN_CLASS_ID,
	)
).address.toString()

function raw(overrides: { factory?: string; hub?: string; network?: string; l1ChainId?: number; walletChainId?: number } = {}) {
	const factory = overrides.factory ?? FACTORY
	return {
		schema: 2,
		network: overrides.network ?? "sandbox",
		l1ChainId: overrides.l1ChainId ?? 31337,
		walletChainId: overrides.walletChainId ?? 31337,
		bridge: {
			l1: {
				registry: "0x0000000000000000000000000000000000000001",
				factory,
				implementation: IMPL,
				guardian: "0x0000000000000000000000000000000000000002",
				router: "0x0000000000000000000000000000000000000003",
				permit2: "0x000000000022d473030f116ddee9f6b43ac78ba3",
				swapTarget: "0x0000000000000000000000000000000000000004",
				feeJuicePortal: FEE_PORTAL,
			},
			l2: {
				hub: {
					address: overrides.hub ?? HUB,
					salt: `0x${"0".repeat(24)}${factory.slice(2)}`,
					constructorArtifact: "constructor",
					constructorArgs: [TOKEN_CLASS_ID, factory, GUARDIAN],
				},
				guardian: GUARDIAN,
				tokenClassId: TOKEN_CLASS_ID,
				tokenArtifactSha256: "a".repeat(64),
			},
			tokens: [
				{
					erc20: ERC20,
					portal: predictPortal(factory, IMPL, ERC20),
					l2Token: L2_TOKEN,
					nameWord: NAME_WORD,
					symbolWord: SYMBOL_WORD,
					decimals: 18,
					displayName: "Test Token",
					displaySymbol: "TST",
					source: "canonical",
				},
			],
		},
		feeJuice: { portal: FEE_PORTAL, asset: "0x762c132040fda6183066fa3b14d985ee55aa3c18", minFj: "16000000000000000000" },
		privateClaimMode: "salt-v2",
	}
}

/** The interlock reads the sync-parsed shape; only the candidate check needs the derivation. */
const parsed = (overrides?: Parameters<typeof raw>[0]): ManifestV2 => raw(overrides) as ManifestV2

describe("assertFaucetCandidateShape", () => {
	it("returns the parsed manifest for a promotable candidate", async () => {
		expect((await assertFaucetCandidateShape(raw())).bridge?.tokens[0].displaySymbol).toBe("TST")
	})

	it("rejects a placeholder manifest and a bridge with no tokens", async () => {
		await expect(assertFaucetCandidateShape({ ...raw(), bridge: null })).rejects.toThrow(/no bridge \(placeholder network\)/)
		const empty = raw()
		empty.bridge.tokens = []
		await expect(assertFaucetCandidateShape(empty)).rejects.toThrow(/carries no tokens/)
	})

	it("rejects anything the strict schema rejects (a carried portal, a foreign claim mode, an L2 token the hub would not derive)", async () => {
		const carried = raw()
		carried.bridge.tokens[0].portal = "0x00000000000000000000000000000000000000ee"
		await expect(assertFaucetCandidateShape(carried)).rejects.toThrow(/not the factory's CREATE2/)
		await expect(assertFaucetCandidateShape({ ...raw(), privateClaimMode: "secret-v1" })).rejects.toThrow(/failed strict validation/)
		const foreign = raw()
		foreign.bridge.tokens[0].l2Token = `0x${"5".repeat(64)}`
		await expect(assertFaucetCandidateShape(foreign)).rejects.toThrow(/is not the hub's derivation/)
	})
})

describe("assertZeroSeed", () => {
	it("accepts a promotion that keeps the network and the generation", () => {
		expect(() => assertZeroSeed(parsed(), parsed())).not.toThrow()
	})

	it("refuses any change of network identity", () => {
		expect(() => assertZeroSeed(parsed({ network: "testnet" }), parsed())).toThrow(/network sandbox → testnet/)
		expect(() => assertZeroSeed(parsed({ l1ChainId: 11155111 }), parsed())).toThrow(/l1ChainId 31337 → 11155111/)
		expect(() => assertZeroSeed(parsed({ walletChainId: 7 }), parsed())).toThrow(/walletChainId 31337 → 7/)
	})

	it("refuses a factory move, a hub swap under the same factory, and dropping a live bridge", () => {
		expect(() => assertZeroSeed(parsed({ factory: "0x4444444444444444444444444444444444444444" }), parsed())).toThrow(
			/change the L1 factory/,
		)
		expect(() => assertZeroSeed(parsed({ hub: `0x${"9".repeat(64)}` }), parsed())).toThrow(/change the L2 hub/)
		const placeholder = { ...parsed(), bridge: null }
		expect(() => assertZeroSeed(placeholder, parsed())).toThrow(/would drop the live bridge/)
	})

	it("allows the first bridge onto a live placeholder network", () => {
		expect(() => assertZeroSeed(parsed(), { ...parsed(), bridge: null })).not.toThrow()
	})
})
