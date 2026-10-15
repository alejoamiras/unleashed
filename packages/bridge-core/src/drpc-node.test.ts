import { describe, expect, it } from "vitest"
import { requireDrpcNodeUrl } from "./drpc-node"

// Booleans only: a failing `toBe` on a URL or a message would print the key it carries.
describe("requireDrpcNodeUrl", () => {
	const key = "sentinel_Key-0123456789"

	it("composes each network's aztec-<network> URL from the key", () => {
		for (const network of ["testnet", "mainnet"] as const) {
			const url = requireDrpcNodeUrl(network, { DRPC_API_KEY: key })
			expect(url === `https://lb.drpc.live/aztec-${network}/${key}`).toBe(true)
		}
	})

	it("refuses an unset, empty or non-URL-safe key, naming the variable but never its value", () => {
		for (const value of [undefined, "", `${key}/../aztec-mainnet`, `${key}?x=1`, `${key}@evil.example`, `${key}\n`]) {
			let message = ""
			try {
				requireDrpcNodeUrl("testnet", { DRPC_API_KEY: value })
			} catch (err) {
				message = err instanceof Error ? err.message : String(err)
			}
			expect(message.includes("DRPC_API_KEY")).toBe(true)
			expect(message.includes(key)).toBe(false)
		}
	})
})
