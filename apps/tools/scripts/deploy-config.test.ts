import { FAUCET_TOKENS, TESTNET_NODE_URL } from "@unleashed/bridge-core"
import { afterEach, describe, expect, it, vi } from "vitest"
import { getDeploymentConfig } from "./deploy-config"

describe("getDeploymentConfig", () => {
	afterEach(() => vi.unstubAllEnvs())

	it("deploys the faucet catalog to the testnet node unless AZTEC_NODE_URL overrides it", () => {
		vi.stubEnv("AZTEC_NODE_URL", "")
		expect(getDeploymentConfig("testnet")).toMatchObject({
			network: { nodeUrl: TESTNET_NODE_URL },
			contracts: { tokens: FAUCET_TOKENS },
		})
		vi.stubEnv("AZTEC_NODE_URL", "http://127.0.0.1:8080")
		expect(getDeploymentConfig("testnet").network.nodeUrl).toBe("http://127.0.0.1:8080")
	})
})
