import { bridgeWitnessPermitTypedData } from "@unleashed/bridge-core"
import { describe, expect, it, vi } from "vitest"
import { TESTNET_L1_CHAIN_ID, TESTNET_WALLET_CHAIN_ID } from "./chain-constants"
import { NETWORK } from "./network"

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
	it("bridgeWitnessPermitTypedData(...NETWORK.l1ChainId) → domain.chainId === NETWORK.l1ChainId", () => {
		const typed = bridgeWitnessPermitTypedData(
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
