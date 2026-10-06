import { privateKeyToAccount } from "viem/accounts"
import { describe, expect, it, vi } from "vitest"
import { BASE_SEPOLIA_RPC_DEFAULT, fillCli, fillConfigFromEnv, SEPOLIA_RPC_DEFAULT } from "./fill-testnet"
import { createL1Clients, createL1PublicClient } from "./script-bootstrap"

vi.mock("./script-bootstrap", async (importOriginal) => ({
	...(await importOriginal<typeof import("./script-bootstrap")>()),
	createL1Clients: vi.fn(() => {
		throw new Error("built a signing client")
	}),
	createL1PublicClient: vi.fn(() => {
		throw new Error("built a client")
	}),
}))

const HASH = `0x${"ab".repeat(32)}`
const KEY = `0x${"11".repeat(32)}` as const
const PINNED = privateKeyToAccount(KEY).address
const argv = (...rest: string[]) => ["bun", "scripts/fill-testnet.ts", ...rest]

describe("fill-testnet's configuration", () => {
	it("signs with CANARY_PRIVATE_KEY alone and defaults both endpoints to PublicNode", () => {
		const cfg = fillConfigFromEnv({ CANARY_PRIVATE_KEY: KEY }, argv(HASH), PINNED)
		expect(cfg.account.address).toBe(PINNED)
		expect([cfg.sourceRpcUrl, cfg.destinationRpcUrl]).toEqual([BASE_SEPOLIA_RPC_DEFAULT, SEPOLIA_RPC_DEFAULT])
		const overridden = fillConfigFromEnv(
			{ CANARY_PRIVATE_KEY: KEY, BASE_SEPOLIA_RPC_URL: "http://b", SEPOLIA_RPC_URL: "http://s" },
			argv(HASH),
			PINNED,
		)
		expect([overridden.sourceRpcUrl, overridden.destinationRpcUrl]).toEqual(["http://b", "http://s"])
		expect(() => fillConfigFromEnv({ PRIVATE_KEY: KEY }, argv(HASH), PINNED)).toThrow(/CANARY_PRIVATE_KEY is not set/)
	})

	it("refuses anything but exactly one 32-byte source hash", () => {
		for (const args of [[], ["0x1234"], [HASH.slice(2)], [HASH, HASH]]) {
			expect(() => fillConfigFromEnv({ CANARY_PRIVATE_KEY: KEY }, argv(...args), PINNED)).toThrow(/exactly one 32-byte/)
		}
	})

	it("never echoes a key it refuses", () => {
		for (const bad of [`0x${"zz".repeat(32)}`, `0x${"00".repeat(32)}`, "11".repeat(32), `0x${"ff".repeat(32)}`]) {
			let message = ""
			try {
				fillConfigFromEnv({ CANARY_PRIVATE_KEY: bad }, argv(HASH), PINNED)
			} catch (e) {
				message = String(e)
			}
			expect(message).toMatch(/CANARY_PRIVATE_KEY is not a valid/)
			expect(message).not.toContain(bad.replace(/^0x/, "").slice(0, 8))
		}
	})

	it("refuses an unpinned canary or a key that is not the pin before any client exists", async () => {
		const env = { CANARY_PRIVATE_KEY: KEY }
		await expect(fillCli(env, argv(HASH), null)).rejects.toThrow(/no testnet canary is pinned/)
		await expect(fillCli(env, argv(HASH), `0x${"cb".repeat(20)}`)).rejects.toThrow(/not the pinned canary/)
		expect(createL1PublicClient).not.toHaveBeenCalled()
		expect(createL1Clients).not.toHaveBeenCalled()
		// The pinned key passes the gate and reaches the clients.
		await expect(fillCli(env, argv(HASH), PINNED.toLowerCase())).rejects.toThrow(/built a client/)
	})
})
