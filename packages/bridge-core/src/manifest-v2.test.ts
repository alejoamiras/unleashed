import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { describe, expect, it } from "vitest"
import { deriveHubTokenInstance } from "./hub-token"
import { assertManifestTokensDerive, deriveManifestHub, manifestToken, parseManifestV2, parseManifestV2Strict } from "./manifest-v2"
import { predictPortal } from "./portal-address"

const TOKEN_CLASS_ID = "0x24c34002788720c941a327a20c369b12c8bdcff3b5a974673a8f618763471505"
const FACTORY = "0x3333333333333333333333333333333333333333"
const IMPL = "0x1111111111111111111111111111111111111111"
const ERC20 = "0x00000000000000000000000000000000000e2c20"
const GUARDIAN = "0x0000000000000000000000000000000000000000000000000000000000000ab1"
const NAME_WORD = "0x005465737420546f6b656e000000000000000000000000000000000000000000"
const SYMBOL_WORD = "0x0054535400000000000000000000000000000000000000000000000000000000"
const FEE_PORTAL = "0xb4a9f8eadc8ca944729d61e59a9f491faff237a3"
const HUB_RECORD = {
	salt: `0x${"0".repeat(24)}${FACTORY.slice(2)}`,
	constructorArtifact: "constructor",
	constructorArgs: [TOKEN_CLASS_ID, FACTORY, GUARDIAN],
}
const HUB = (
	await deriveManifestHub({ l2: { hub: { ...HUB_RECORD, address: "" } } } as unknown as Parameters<typeof deriveManifestHub>[0])
).address.toString()

async function fixture() {
	const inst = await deriveHubTokenInstance(
		AztecAddress.fromStringUnsafe(HUB),
		ERC20,
		{ nameWord: NAME_WORD, symbolWord: SYMBOL_WORD, decimals: 18 },
		TOKEN_CLASS_ID,
	)
	return {
		schema: 2,
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
				hub: { ...HUB_RECORD, address: HUB },
				guardian: GUARDIAN,
				tokenClassId: TOKEN_CLASS_ID,
				tokenArtifactSha256: "a".repeat(64),
			},
			tokens: [
				{
					erc20: ERC20,
					portal: predictPortal(FACTORY, IMPL, ERC20),
					l2Token: inst.address.toString(),
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
		feeJuice: { portal: FEE_PORTAL, asset: "0x762c132040fda6183066fa3b14d985ee55aa3c18", minFj: "16000000000000000000" },
		privateClaimMode: "salt-v2",
	}
}

describe("manifest v2 (strict, self-deriving)", () => {
	it("accepts a coherent manifest and derives every token", async () => {
		const m = await parseManifestV2Strict(await fixture())
		expect(m.bridge?.tokens[0].displaySymbol).toBe("TST")
		expect(manifestToken(m, ERC20.toUpperCase())?.erc20).toBe(ERC20)
		expect(manifestToken(m, "0x0000000000000000000000000000000000000009")).toBeUndefined()
	})

	it("accepts bridge: null (the placeholder network)", async () => {
		const m = parseManifestV2({ ...(await fixture()), bridge: null })
		expect(m.bridge).toBeNull()
		await expect(assertManifestTokensDerive(m)).resolves.toBeUndefined()
	})

	it("rejects a portal that is not the factory's CREATE2 for the token", async () => {
		const raw = await fixture()
		raw.bridge.tokens[0].portal = "0x00000000000000000000000000000000000000ee"
		expect(() => parseManifestV2(raw)).toThrow(/tokens\.0\.portal: portal is not the factory's CREATE2/)
	})

	it("rejects an l2Token the hub would not derive", async () => {
		const raw = await fixture()
		raw.bridge.tokens[0].l2Token = `0x${"1".repeat(64)}`
		await expect(parseManifestV2Strict(raw)).rejects.toThrow(/is not the hub's derivation/)
	})

	it("rejects a hub address that is not the instantiation of its own record, and a salt that is not the factory", async () => {
		const carried = await fixture()
		carried.bridge.l2.hub.address = `0x${"2".repeat(64)}`
		await expect(parseManifestV2Strict(carried)).rejects.toThrow(/not the instantiation of its own record/)
		const foreignSalt = await fixture()
		foreignSalt.bridge.l2.hub.salt = `0x${"3".repeat(64)}`
		expect(() => parseManifestV2(foreignSalt)).toThrow(/hub salt must be the factory/)
	})

	it("rejects hub constructor args that disagree with the manifest", async () => {
		const raw = await fixture()
		raw.bridge.l2.hub.constructorArgs = [TOKEN_CLASS_ID, "0x0000000000000000000000000000000000000009", GUARDIAN]
		expect(() => parseManifestV2(raw)).toThrow(/hub constructorArgs must be \[tokenClassId, factory, guardian\]/)
	})

	it("rejects hooked pools, a feeJuicePortal mismatch, duplicate tokens and unknown keys", async () => {
		const hooked = await fixture()
		;(hooked.bridge.tokens[0] as { pools?: unknown }).pools = {
			weth: { fee: 3000, tickSpacing: 60, hooks: "0x0000000000000000000000000000000000000001" },
		}
		expect(() => parseManifestV2(hooked)).toThrow(/hooked pools are not routable/)

		const mismatch = await fixture()
		mismatch.bridge.l1.feeJuicePortal = "0x0000000000000000000000000000000000000009"
		expect(() => parseManifestV2(mismatch)).toThrow(/must equal feeJuice\.portal/)

		const dup = await fixture()
		dup.bridge.tokens.push({ ...dup.bridge.tokens[0], erc20: ERC20.toUpperCase().replace("0X", "0x") })
		expect(() => parseManifestV2(dup)).toThrow(/duplicate token/)

		const unknown = await fixture()
		;(unknown as { extra?: unknown }).extra = 1
		expect(() => parseManifestV2(unknown)).toThrow(/Unrecognized key/)
	})
})

const ROUTER = "0x00000000000000000000000000000000000000d1"
const SWAPPER = "0x00000000000000000000000000000000000000d2"
const RETIRED = "0x0000000000000000000000000000000000000003"
const FUEL = { slippageBps: 100, crossChainSlippageBps: 150, minFuelFj: "1", fjPerTx: "2", fjRegister: "3" }
const SOURCE_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"

/** The fixture with a DepositRouter, its swapper and one LI.FI source delivering the manifest token. */
async function routed() {
	const raw = await fixture()
	const l1 = raw.bridge.l1 as Record<string, unknown>
	Object.assign(l1, { depositRouter: ROUTER, fuelSwapper: SWAPPER, fuel: FUEL, legacyRouters: [RETIRED] })
	;(raw.bridge as Record<string, unknown>).routing = {
		provider: "lifi",
		sources: [{ chainId: 84532, rail: "acrossV4", tokens: [{ address: SOURCE_USDC, symbol: "USDC", decimals: 6, destToken: ERC20 }] }],
	}
	return raw as typeof raw & {
		bridge: { l1: Record<string, unknown>; routing: { sources: { chainId: number; tokens: { destToken: string }[] }[] } }
	}
}

describe("manifest v2 DepositRouter fields", () => {
	it("accepts the router, swapper, budgets, legacy routers and routing; a manifest without them still parses", async () => {
		const m = parseManifestV2(await routed())
		expect(m.bridge?.l1.depositRouter).toBe(ROUTER)
		expect(m.bridge?.routing?.sources[0].rail).toBe("acrossV4")
		expect(parseManifestV2({ ...(await fixture()) }).bridge?.l1.depositRouter).toBeUndefined()
	})

	it("refuses the testnet swapper on mainnet and a router without its swapper or budgets elsewhere", async () => {
		const mainnet = await routed()
		Object.assign(mainnet, { l1ChainId: 1, walletChainId: 1 })
		expect(() => parseManifestV2(mainnet)).toThrow(/fuel swapper is refused on Ethereum mainnet/)
		mainnet.bridge.l1.fuelSwapper = undefined
		expect(parseManifestV2(mainnet).bridge?.l1.fuelSwapper).toBeUndefined()

		const noSwapper = await routed()
		noSwapper.bridge.l1.fuelSwapper = undefined
		expect(() => parseManifestV2(noSwapper)).toThrow(/fuelSwapper is present exactly when depositRouter is/)
		const noBudgets = await routed()
		noBudgets.bridge.l1.fuel = undefined
		expect(() => parseManifestV2(noBudgets)).toThrow(/needs the fuel budgets/)
	})

	it("refuses routing to a token without a portal, a destination-chain source, duplicates and a routerless route", async () => {
		const portalless = await routed()
		portalless.bridge.routing.sources[0].tokens[0].destToken = "0x00000000000000000000000000000000000000e9"
		expect(() => parseManifestV2(portalless)).toThrow(/destToken must be a manifest token/)
		const loop = await routed()
		loop.bridge.routing.sources[0].chainId = 31337
		expect(() => parseManifestV2(loop)).toThrow(/cannot be the destination/)
		const dupChain = await routed()
		dupChain.bridge.routing.sources.push({ ...dupChain.bridge.routing.sources[0] })
		expect(() => parseManifestV2(dupChain)).toThrow(/duplicate source chain/)
		const legacy = await routed()
		legacy.bridge.l1.legacyRouters = [ROUTER]
		expect(() => parseManifestV2(legacy)).toThrow(/the current router is not legacy/)
		const routerless = await routed()
		for (const k of ["depositRouter", "fuelSwapper", "fuel"]) delete routerless.bridge.l1[k]
		expect(() => parseManifestV2(routerless)).toThrow(/routing needs a depositRouter/)
	})
})
