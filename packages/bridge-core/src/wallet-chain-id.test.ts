import { describe, expect, it } from "vitest"
import { walletChainIdOf } from "./wallet-chain-id"

describe("walletChainIdOf", () => {
	it("reproduces the two live networks' wallet chain ids", () => {
		expect(walletChainIdOf(11155111, 2914217885)).toBe(2904119610)
		expect(walletChainIdOf(1, 4248422647)).toBe(4248422646)
	})

	it("is never the bare rollup version and never negative", () => {
		expect(walletChainIdOf(31337, 31337)).toBe(0)
		expect(walletChainIdOf(1, 0xffffffff)).toBe(0xfffffffe)
	})
})
