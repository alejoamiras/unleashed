import { describe, expect, it } from "vitest"
import { selfBuiltTerms, TESTNET_FILLER } from "./across-self-built"

describe("selfBuiltTerms", () => {
	it("keeps a quarter for the relay and gives the filler alone two hours on testnet, and refuses a mainnet manifest", () => {
		expect(selfBuiltTerms(11_155_111, 5_000_000n, 1_000, TESTNET_FILLER)).toEqual({
			quote: "self-built",
			outputAmount: 3_750_000n,
			quoteTimestamp: 1_000,
			fillDeadline: 8_200,
			etaSeconds: 7_200,
			exclusiveRelayer: TESTNET_FILLER,
		})
		expect(() => selfBuiltTerms(1, 5_000_000n, 1_000, TESTNET_FILLER)).toThrow(/testnet-only/)
	})
})
