import { depositWitnessPermitTypedData } from "@unleashed/bridge-core"
import { describe, expect, it, vi } from "vitest"
import { TESTNET_L1_CHAIN_ID, TESTNET_WALLET_CHAIN_ID } from "./chain-constants"
import { NETWORK, readChainOf, sourcesOf } from "./network"

describe("NETWORK — single-source chain identity", () => {
	it("the two L1 chain-id sources agree (viem Chain vs the Node-safe constant)", () => {
		// If these ever diverge, viem clients and the Permit2 domain would disagree — the module-load
		// guard in network.ts throws, and this pins it in the fast test loop too.
		expect(NETWORK.l1ChainId).toBe(NETWORK.viemChain.id)
		expect(NETWORK.l1ChainId).toBe(TESTNET_L1_CHAIN_ID)
	})

	it("carries the wallet (Aztec) chain id from chain-constants", () => {
		expect(NETWORK.walletChainId).toBe(TESTNET_WALLET_CHAIN_ID)
	})
})

describe("sourcesOf — the source registry", () => {
	const USDC = "0x036cbd53842c5426634e7929541ec2318f3dcf7e"
	const routed = (chainId: number) => ({
		l1ChainId: TESTNET_L1_CHAIN_ID,
		bridge: {
			routing: {
				provider: "lifi" as const,
				sources: [
					{ chainId, rail: "acrossV4" as const, tokens: [{ address: USDC, symbol: "USDC", decimals: 6, destToken: USDC }] },
				],
			},
		},
	})

	it("joins a routed source with the Chain the app signs on and the RPCs this build reads it through", () => {
		const [src] = sourcesOf(routed(84532) as never)
		expect(src.chain.id).toBe(84532)
		expect(src.rpcUrls).toEqual(["https://base-sepolia-rpc.publicnode.com", "https://sepolia.base.org"])
		expect(src.tokens[0].symbol).toBe("USDC")
		expect(sourcesOf({ l1ChainId: TESTNET_L1_CHAIN_ID, bridge: null })).toEqual([])
	})

	it("refuses a source that delivers into another Ethereum, or one no catalogue knows", () => {
		expect(() => sourcesOf(routed(8453) as never)).toThrow(/delivers into chain 1/)
		expect(() => sourcesOf(routed(31338) as never)).toThrow(/not a known source/)
	})

	it("reads Ethereum and every source, nothing else", () => {
		expect(readChainOf(TESTNET_L1_CHAIN_ID)?.chain.id).toBe(TESTNET_L1_CHAIN_ID)
		expect(readChainOf(84532)?.rpcUrls).toHaveLength(2)
		// A known mainnet source has a Chain but no RPC on this build.
		expect(readChainOf(8453)?.rpcUrls).toEqual([])
		expect(readChainOf(137)).toBeUndefined()
	})
})

describe("L1_CHAIN_LABEL — the FROM/TO panel chip", () => {
	it("testnet (default target) → network-qualified", async () => {
		const { L1_CHAIN_LABEL } = await import("./network")
		expect(L1_CHAIN_LABEL).toBe("Ethereum · Sepolia")
	})

	it("mainnet target → plain Ethereum", async () => {
		vi.stubEnv("VITE_TOOLS_TARGET", "mainnet")
		vi.resetModules()
		try {
			const { L1_CHAIN_LABEL } = await import("./network")
			expect(L1_CHAIN_LABEL).toBe("Ethereum")
		} finally {
			vi.unstubAllEnvs()
			vi.resetModules()
		}
	})
})

// The Permit2 EIP-712 domain chain id MUST come from NETWORK.l1ChainId. Combined with the
// Biome `viem/chains` ban (nothing outside network.ts can supply a raw `sepolia.id`), a
// half-switched build cannot sign a witness against the wrong chain — which would revert 100% of
// deposits at `permitWitnessTransferFrom`.
describe("Permit2 witness domain is bound to NETWORK.l1ChainId", () => {
	it("depositWitnessPermitTypedData(...NETWORK.l1ChainId) → domain.chainId === NETWORK.l1ChainId", () => {
		const typed = depositWitnessPermitTypedData(
			{
				permitted: { token: "0x0000000000000000000000000000000000000001", amount: 1n },
				spender: "0x0000000000000000000000000000000000000002",
				nonce: 0n,
				deadline: 0n,
			} as never,
			{} as never,
			"0x0000000000000000000000000000000000000003" as never,
			NETWORK.l1ChainId,
		)
		expect(typed.domain.chainId).toBe(NETWORK.l1ChainId)
	})
})
