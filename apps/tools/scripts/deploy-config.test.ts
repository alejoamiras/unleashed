// @vitest-environment node
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { FAUCET_TOKENS, requireDrpcNodeUrl } from "@unleashed/bridge-core"
import { dripCatalog } from "@unleashed/bridge-core/drip-deploy"
import { afterEach, describe, expect, it, vi } from "vitest"
import { buildDeploymentJson, fundingOf, getDeploymentConfig, nodeUrlFor, resolveDeployerKeys } from "./deploy-config"

describe("getDeploymentConfig", () => {
	it("deploys the faucet catalog", () => {
		expect(getDeploymentConfig("testnet").contracts.tokens).toBe(FAUCET_TOKENS)
	})

	it("derives the committed deployments.json on mainnet: one file serves both networks", async () => {
		const [dripper, ...tokens] = await dripCatalog()
		const json = buildDeploymentJson(
			dripper?.instance.address as never,
			Object.fromEntries(tokens.map((t) => [String(t.args[1]), t.instance.address])),
			getDeploymentConfig("mainnet"),
		)
		const committed = JSON.parse(readFileSync(join(import.meta.dirname, "..", "src", "contracts", "deployments.json"), "utf8"))
		expect(json).toEqual(committed)
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

describe("fundingOf", () => {
	const flags = (f: Record<string, string>) => (name: string) => f[name]

	it("requires --cap on a live mainnet run and parses both amounts in AZTEC", () => {
		expect(() => fundingOf("mainnet", flags({ "--fund": "20" }), false)).toThrow(/needs --cap/)
		expect(fundingOf("mainnet", flags({ "--fund": "20", "--cap": "60.5" }), false)).toEqual({
			fund: 20n * 10n ** 18n,
			cap: 605n * 10n ** 17n,
		})
		expect(fundingOf("mainnet", flags({}), true)).toEqual({})
	})

	it("refuses an amount it cannot read, and any funding off mainnet", () => {
		expect(() => fundingOf("mainnet", flags({ "--cap": "1e3" }), false)).toThrow(/amount of AZTEC/)
		expect(() => fundingOf("testnet", flags({ "--fund": "1" }), false)).toThrow(/mainnet only/)
	})
})

describe("resolveDeployerKeys", () => {
	const passphrase = { DEPLOYER_SECRET: "x".repeat(32) }

	it("refuses the passphrase fallback on mainnet, where the hex pair still works", async () => {
		await expect(resolveDeployerKeys("mainnet", passphrase)).rejects.toThrow(/DEPLOYER_SECRET_KEY \+ DEPLOYER_SALT only/)
		await expect(resolveDeployerKeys("testnet", passphrase)).resolves.toBeDefined()
		const pair = { DEPLOYER_SECRET_KEY: `0x${"ab".repeat(32)}`, DEPLOYER_SALT: "0x01" }
		await expect(resolveDeployerKeys("mainnet", pair)).resolves.toBeDefined()
	})
})
