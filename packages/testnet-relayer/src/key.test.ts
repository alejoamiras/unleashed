import { privateKeyToAccount } from "viem/accounts"
import { expect, it } from "vitest"
import { relayerAccount } from "./key"

it("reads RELAYER_PRIVATE_KEY alone and never echoes a value it refuses", () => {
	const key = `0x${"11".repeat(32)}` as const
	expect(relayerAccount({ RELAYER_PRIVATE_KEY: key }).address).toBe(privateKeyToAccount(key).address)
	expect(() => relayerAccount({ PRIVATE_KEY: key })).toThrow(/RELAYER_PRIVATE_KEY is not set/)
	for (const bad of [`0x${"zz".repeat(32)}`, "11".repeat(32), `0x${"00".repeat(32)}`, `0x${"ff".repeat(32)}`]) {
		let message = ""
		try {
			relayerAccount({ RELAYER_PRIVATE_KEY: bad })
		} catch (e) {
			message = String(e)
		}
		expect(message).toMatch(/RELAYER_PRIVATE_KEY is not a/)
		expect(message).not.toContain(bad.replace(/^0x/, "").slice(0, 8))
	}
})
