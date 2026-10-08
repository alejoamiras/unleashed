import { describe, expect, it } from "vitest"
import { TESTNET_L1_CHAIN_ID } from "./chain-constants"
import { chainBadge, chainLabel, chainTxUrl, isEthereum, lifiScanUrl, railLabel } from "./chains"

const HASH = `0x${"ab".repeat(32)}`

describe("chains — how a chain is worded and linked", () => {
	it("names the bridge's L1 and the source chains the screens show", () => {
		expect(isEthereum(TESTNET_L1_CHAIN_ID)).toBe(true)
		expect(chainLabel(TESTNET_L1_CHAIN_ID)).toBe("Ethereum · Sepolia")
		expect(chainBadge(TESTNET_L1_CHAIN_ID)).toBe("ETH")
		expect(chainLabel(84532)).toBe("Base Sepolia")
		expect(chainBadge(84532)).toBe("BASE")
		expect(chainLabel(42161)).toBe("Arbitrum")
		expect(chainBadge(10)).toBe("OP")
		expect(railLabel("acrossV4")).toBe("Across")
	})

	it("links a hash only on a chain with an explorer, and only a well-formed one", () => {
		expect(chainTxUrl(84532, HASH)).toBe(`https://sepolia.basescan.org/tx/${HASH}`)
		expect(chainTxUrl(84532, "0x1234")).toBe("")
		expect(chainTxUrl(999_999, HASH)).toBe("")
		expect(lifiScanUrl(HASH)).toBe(`https://scan.li.fi/tx/${HASH}`)
		expect(lifiScanUrl("javascript:alert(1)")).toBe("")
	})
})
