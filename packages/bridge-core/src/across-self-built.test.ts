import { describe, expect, it } from "vitest"
import { selfBuiltTerms } from "./across-self-built"

describe("selfBuiltTerms", () => {
	it("keeps a quarter for the relay and gives the fill two hours on testnet, and refuses a mainnet manifest", () => {
		expect(selfBuiltTerms(11_155_111, 5_000_000n, 1_000)).toEqual({
			quote: "self-built",
			outputAmount: 3_750_000n,
			quoteTimestamp: 1_000,
			fillDeadline: 8_200,
			etaSeconds: 7_200,
		})
		expect(() => selfBuiltTerms(1, 5_000_000n, 1_000)).toThrow(/testnet-only/)
	})
})
