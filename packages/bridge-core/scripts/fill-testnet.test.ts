import { privateKeyToAccount } from "viem/accounts"
import { describe, expect, it } from "vitest"
import { BASE_SEPOLIA_RPC_DEFAULT, fillConfigFromEnv, SEPOLIA_RPC_DEFAULT } from "./fill-testnet"

const HASH = `0x${"ab".repeat(32)}`
const KEY = `0x${"11".repeat(32)}` as const
const argv = (...rest: string[]) => ["bun", "scripts/fill-testnet.ts", ...rest]

describe("fill-testnet's configuration", () => {
	it("signs with CANARY_PRIVATE_KEY alone and defaults both endpoints to PublicNode", () => {
		const cfg = fillConfigFromEnv({ CANARY_PRIVATE_KEY: KEY }, argv(HASH))
		expect(cfg.account.address).toBe(privateKeyToAccount(KEY).address)
		expect([cfg.sourceRpcUrl, cfg.destinationRpcUrl]).toEqual([BASE_SEPOLIA_RPC_DEFAULT, SEPOLIA_RPC_DEFAULT])
		const overridden = fillConfigFromEnv(
			{ CANARY_PRIVATE_KEY: KEY, BASE_SEPOLIA_RPC_URL: "http://b", SEPOLIA_RPC_URL: "http://s" },
			argv(HASH),
		)
		expect([overridden.sourceRpcUrl, overridden.destinationRpcUrl]).toEqual(["http://b", "http://s"])
		expect(() => fillConfigFromEnv({ PRIVATE_KEY: KEY }, argv(HASH))).toThrow(/CANARY_PRIVATE_KEY is not set/)
	})

	it("refuses anything but exactly one 32-byte source hash", () => {
		for (const args of [[], ["0x1234"], [HASH.slice(2)], [HASH, HASH]]) {
			expect(() => fillConfigFromEnv({ CANARY_PRIVATE_KEY: KEY }, argv(...args))).toThrow(/exactly one 32-byte/)
		}
	})

	it("never echoes a key it refuses", () => {
		for (const bad of [`0x${"zz".repeat(32)}`, `0x${"00".repeat(32)}`, "11".repeat(32), `0x${"ff".repeat(32)}`]) {
			let message = ""
			try {
				fillConfigFromEnv({ CANARY_PRIVATE_KEY: bad }, argv(HASH))
			} catch (e) {
				message = String(e)
			}
			expect(message).toMatch(/CANARY_PRIVATE_KEY is not a valid/)
			expect(message).not.toContain(bad.replace(/^0x/, "").slice(0, 8))
		}
	})
})
