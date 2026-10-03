import { describe, expect, it } from "vitest"
import { resolveDeployerKeys } from "./deployer-keys"

const SECRET = "correct-horse-battery-staple"
const MAINNET = { BRIDGE_DEPLOYER_SECRET_MAINNET: SECRET, BRIDGE_DEPLOYER_PREFIX_MAINNET: "example-prefix" }

describe("resolveDeployerKeys — stable, network-separated L2 deployer", () => {
	it("pins the derivation: sha256(prefix:field:network:secret), truncated to 31 bytes", () => {
		const k = resolveDeployerKeys("testnet", { BRIDGE_DEPLOYER_SECRET_TESTNET: SECRET })
		expect(k.secret.toString()).toBe("0x00cf699039e6ad5cb1b4b06f3a79ed2dea2a3640183fad2d4aa3057a46f2568a")
		expect(k.salt.toString()).toBe("0x003fd2e628d3cadd182ff76ac266bd3a498e9dbcf14b4a1b79db4189ef4d9a23")
		expect(resolveDeployerKeys("mainnet", MAINNET).secret.toString()).toBe(
			"0x0010f36fbc82df03fedf579ec68add3febd3b64ff26793a943f65b644f11fab1",
		)
	})

	it("networks NEVER share an identity — even the same raw secret and prefix derive different keys", () => {
		const prefix = "example-prefix"
		const t = resolveDeployerKeys("testnet", { BRIDGE_DEPLOYER_SECRET_TESTNET: SECRET, BRIDGE_DEPLOYER_PREFIX_TESTNET: prefix })
		const m = resolveDeployerKeys("mainnet", MAINNET)
		expect(t.secret.toString()).not.toBe(m.secret.toString())
		expect(t.salt.toString()).not.toBe(m.salt.toString())
	})

	it("fails closed on a missing or short secret, naming the network's own env var", () => {
		expect(() => resolveDeployerKeys("mainnet", {})).toThrow(/BRIDGE_DEPLOYER_SECRET_MAINNET/)
		expect(() => resolveDeployerKeys("testnet", { BRIDGE_DEPLOYER_SECRET_TESTNET: "short" })).toThrow(/16/)
		// The mainnet lookup never falls back to the testnet var.
		expect(() => resolveDeployerKeys("mainnet", { BRIDGE_DEPLOYER_SECRET_TESTNET: SECRET })).toThrow(/BRIDGE_DEPLOYER_SECRET_MAINNET/)
	})

	it("mainnet has no default prefix, and never borrows testnet's", () => {
		const secret = { BRIDGE_DEPLOYER_SECRET_MAINNET: SECRET }
		expect(() => resolveDeployerKeys("mainnet", secret)).toThrow(/BRIDGE_DEPLOYER_PREFIX_MAINNET is required/)
		expect(() => resolveDeployerKeys("mainnet", { ...secret, BRIDGE_DEPLOYER_PREFIX_MAINNET: "" })).toThrow(/is required/)
		expect(() => resolveDeployerKeys("mainnet", { ...secret, BRIDGE_DEPLOYER_PREFIX_TESTNET: "example-prefix" })).toThrow(/is required/)
	})

	it("refuses a prefix that could forge the field or network segments", () => {
		for (const prefix of ["a:secret:mainnet", "Has-Caps", "ab", " padded-prefix"]) {
			expect(() => resolveDeployerKeys("mainnet", { ...MAINNET, BRIDGE_DEPLOYER_PREFIX_MAINNET: prefix }), prefix).toThrow(
				/must match/,
			)
		}
	})
})
