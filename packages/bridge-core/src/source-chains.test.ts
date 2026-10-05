import { describe, expect, it } from "vitest"
import { enabledSources, SOURCE_CHAINS, sourceChain } from "./source-chains"

const SEPOLIA_USDC = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238"
const baseSepoliaUsdc = { address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", symbol: "USDC", decimals: 6, destToken: SEPOLIA_USDC }

const routing = (sources: { chainId: number; rail: "acrossV4" | "stargateV2" }[]) => ({
	provider: "lifi" as const,
	sources: sources.map((s) => ({ ...s, tokens: [baseSepoliaUsdc] })),
})

describe("source chains", () => {
	it("joins each enabled source with its catalogue entry, keyed consistently and never an L1 itself", () => {
		const [base] = enabledSources({ l1ChainId: 11_155_111, bridge: { routing: routing([{ chainId: 84532, rail: "acrossV4" }]) } })
		expect(base).toEqual({
			chainId: 84532,
			name: "Base Sepolia",
			nativeSymbol: "ETH",
			l1ChainId: 11_155_111,
			rpcUrls: ["https://base-sepolia-rpc.publicnode.com", "https://sepolia.base.org"],
			rail: "acrossV4",
			tokens: [baseSepoliaUsdc],
		})
		for (const [key, chain] of Object.entries(SOURCE_CHAINS)) {
			expect(chain.chainId).toBe(Number(key))
			expect(sourceChain(chain.l1ChainId)).toBeUndefined()
		}
	})

	it("offers nothing when the manifest routes nothing", () => {
		expect(enabledSources({ l1ChainId: 1, bridge: null })).toEqual([])
		expect(enabledSources({ l1ChainId: 1, bridge: { routing: null } })).toEqual([])
		expect(enabledSources({ l1ChainId: 1, bridge: {} })).toEqual([])
	})

	it("refuses a source it does not know, or one that delivers into another L1", () => {
		expect(() =>
			enabledSources({ l1ChainId: 11_155_111, bridge: { routing: routing([{ chainId: 421614, rail: "acrossV4" }]) } }),
		).toThrow(/421614 is not a known source/)
		expect(() =>
			enabledSources({ l1ChainId: 11_155_111, bridge: { routing: routing([{ chainId: 8453, rail: "stargateV2" }]) } }),
		).toThrow(/Base delivers into chain 1, not 11155111/)
	})
})
