import { FAUCET_TOKENS, requireDrpcNodeUrl } from "@unleashed/bridge-core"
import { afterEach, describe, expect, it, vi } from "vitest"
import { getDeploymentConfig, nodeUrlFor } from "./deploy-config"

describe("getDeploymentConfig", () => {
	it("deploys the faucet catalog", () => {
		expect(getDeploymentConfig("testnet").contracts.tokens).toBe(FAUCET_TOKENS)
	})
})

describe("nodeUrlFor", () => {
	afterEach(() => vi.unstubAllEnvs())

	// A boolean: a failing `toBe` on a keyed URL would print the key.
	it("takes testnet and mainnet from DRPC_API_KEY, whatever AZTEC_NODE_URL says", () => {
		const key = "sentinel_Key-0123456789"
		vi.stubEnv("DRPC_API_KEY", key)
		vi.stubEnv("AZTEC_NODE_URL", "http://127.0.0.1:8080")
		for (const network of ["testnet", "mainnet"] as const) {
			expect(nodeUrlFor(network) === requireDrpcNodeUrl(network, { DRPC_API_KEY: key })).toBe(true)
		}
	})

	it("keeps the local network's loopback default, which AZTEC_NODE_URL overrides", () => {
		vi.stubEnv("AZTEC_NODE_URL", "")
		expect(nodeUrlFor("local-network")).toBe("http://localhost:8080")
		vi.stubEnv("AZTEC_NODE_URL", "http://127.0.0.1:18080")
		expect(nodeUrlFor("local-network")).toBe("http://127.0.0.1:18080")
	})
})
