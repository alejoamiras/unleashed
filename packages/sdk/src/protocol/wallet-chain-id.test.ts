import { describe, expect, it } from "vitest"
import { walletChainIdOf } from "./wallet-chain-id.ts"

describe("walletChainIdOf", () => {
	it("reproduces the two live networks' wallet chain ids", () => {
		expect(walletChainIdOf(11155111, 679261766)).toBe(685146337)
		expect(walletChainIdOf(1, 2070860440)).toBe(2070860441)
	})

	it("is never the bare rollup version and never negative", () => {
		expect(walletChainIdOf(31337, 31337)).toBe(0)
		expect(walletChainIdOf(1, 0xffffffff)).toBe(0xfffffffe)
	})
})
