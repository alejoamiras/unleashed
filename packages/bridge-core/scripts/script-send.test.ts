import { type Address, decodeFunctionData } from "viem"
import { describe, expect, it, vi } from "vitest"
import type { JournalTokenBlock } from "../src/journal"
import { SWAP_TOKENS_SINGLE_V3_ABI } from "../src/lifi-abi"
import type { BridgeBlock, ManifestToken, ManifestV2 } from "../src/manifest-v2"
import { predictPortal } from "../src/portal-address"
import { claimTokenBlock, planFuelLeg, selectToken } from "./script-send"

const addr = (byte: string) => `0x${byte.repeat(20)}` as Address
const word = (byte: string) => `0x${byte.repeat(32)}`

const FACTORY = addr("2b")
const IMPLEMENTATION = addr("3c")
const ERC20 = addr("4d")
const OTHER_ERC20 = addr("6f")
const FEE_ASSET = addr("5e")

const tokenAt = (erc20: Address, symbol: string): ManifestToken => ({
	erc20,
	portal: predictPortal(FACTORY, IMPLEMENTATION, erc20),
	l2Token: word("11"),
	nameWord: word("00"),
	symbolWord: word("00"),
	decimals: 18,
	displayName: symbol,
	displaySymbol: symbol,
	source: "canonical",
})

const DEPOSIT_ROUTER = addr("c1")
const SWAPPER = addr("c2")

const bridge: BridgeBlock = {
	l1: {
		registry: addr("b1"),
		factory: FACTORY,
		implementation: IMPLEMENTATION,
		guardian: addr("b2"),
		router: addr("b3"),
		permit2: addr("b4"),
		swapTarget: addr("b5"),
		feeJuicePortal: addr("b6"),
		depositRouter: DEPOSIT_ROUTER,
		fuelSwapper: SWAPPER,
		fuel: { slippageBps: 300, crossChainSlippageBps: 100, minFuelFj: "10", fjPerTx: "1", fjRegister: "1" },
	},
	l2: {
		hub: { address: word("22"), salt: word("33"), constructorArtifact: "BridgeHub", constructorArgs: [] },
		guardian: word("44"),
		tokenClassId: word("55"),
		tokenArtifactSha256: "ab".repeat(32),
	},
	tokens: [tokenAt(ERC20, "TKN"), tokenAt(OTHER_ERC20, "OTH")],
}

const readBack = (l2Token: string): JournalTokenBlock => ({
	erc20: ERC20,
	portal: bridge.tokens[0].portal,
	l2Token,
	nameWord: word("00"),
	symbolWord: word("00"),
	decimals: 18,
	displaySymbol: "TKN",
})

describe("selectToken", () => {
	it("takes the first token without --token and matches the flag case-insensitively", () => {
		expect(selectToken(bridge, []).erc20).toBe(ERC20)
		expect(selectToken(bridge, ["--token", OTHER_ERC20.toUpperCase()]).erc20).toBe(OTHER_ERC20)
	})

	it("distinguishes an empty manifest from an unknown token", () => {
		expect(() => selectToken({ ...bridge, tokens: [] }, [])).toThrow(/carries no tokens/)
		expect(() => selectToken(bridge, ["--token", addr("99")])).toThrow(/never been created/)
	})
})

describe("claimTokenBlock", () => {
	it("passes the read-back through when the derived L2 token is the manifest's", () => {
		const block = readBack(word("11").toUpperCase())
		expect(claimTokenBlock(bridge.tokens[0], block)).toBe(block)
	})

	it("names both addresses when the derivation disagrees with the manifest", () => {
		expect(() => claimTokenBlock(bridge.tokens[0], readBack(word("99")))).toThrow(
			new RegExp(`derives L2 token ${word("99")}, the manifest says ${word("11")}`),
		)
	})
})

describe("planFuelLeg", () => {
	const manifest = { l1ChainId: 31337, feeJuice: { asset: FEE_ASSET }, bridge } as unknown as ManifestV2

	it("refuses the fee asset itself — its gas leg belongs to the direct lane", async () => {
		const pub = { readContract: vi.fn() }
		await expect(planFuelLeg(pub, manifest, FEE_ASSET, 1n)).rejects.toThrow(/IS the fee asset/)
		expect(pub.readContract).not.toHaveBeenCalled()
	})

	it("quotes the swapper at the slice and signs the floored call the router hands it", async () => {
		const pub = { readContract: vi.fn(async () => 1_000n) }
		const plan = await planFuelLeg(pub, manifest, ERC20, 5n)
		expect(pub.readContract).toHaveBeenCalledWith(
			expect.objectContaining({ address: SWAPPER, functionName: "quote", args: [ERC20, 5n] }),
		)
		expect(plan.quote).toBe(1_000n)
		expect(plan.minFuelOutput).toBe(970n)
		const call = decodeFunctionData({ abi: SWAP_TOKENS_SINGLE_V3_ABI, data: plan.swapData })
		expect(String(call.args[3]).toLowerCase()).toBe(DEPOSIT_ROUTER)
		expect(call.args[4]).toBe(970n)
	})

	it("refuses a token the swapper has no rate for rather than sending an unfueled claim", async () => {
		const pub = { readContract: vi.fn(async () => Promise.reject(new Error("NoRate"))) }
		await expect(planFuelLeg(pub, manifest, ERC20, 1n)).rejects.toThrow(/no fuel quote for 0x4d.*provider/)
	})
})
