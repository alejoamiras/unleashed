import { Fr } from "@aztec-labs/aztec.js/fields"
import { afterEach, describe, expect, it, vi } from "vitest"
import { TESTNET_L1_CHAIN_ID, TESTNET_ROLLUP_VERSION, TESTNET_WALLET_CHAIN_ID } from "./chain-constants"
import { readChainInfo } from "./chain-info"

describe("chain-constants", () => {
	it("canonical V6 testnet wallet chainId is 2904119610", () => {
		expect(TESTNET_WALLET_CHAIN_ID).toBe(2904119610)
		expect((TESTNET_L1_CHAIN_ID ^ TESTNET_ROLLUP_VERSION) >>> 0).toBe(2904119610)
	})

	it("(BUG PIN) the stale rollup version would have given 4138294185", () => {
		// The value a stale VITE_CHAIN_VERSION=4127419662 produced in prod.
		expect((TESTNET_L1_CHAIN_ID ^ 4127419662) >>> 0).toBe(4138294185)
	})
})

describe("readChainInfo", () => {
	const url = (qs: string) => new URL(`https://app.unleashed.systems/${qs}`)

	it("defaults to the testnet constants (no env override path exists)", () => {
		const info = readChainInfo(url(""))
		expect(info.chainId.equals(new Fr(TESTNET_L1_CHAIN_ID))).toBe(true)
		expect(info.version.equals(new Fr(TESTNET_ROLLUP_VERSION))).toBe(true)
	})

	it("never resolves to the Fr.ZERO wildcard (the prior no-accounts UX hole)", () => {
		const info = readChainInfo(url(""))
		expect(info.chainId.isZero()).toBe(false)
		expect(info.version.isZero()).toBe(false)
	})

	it("honors the ?chainId=&version= URL override in a DEV build (test driver)", () => {
		const info = readChainInfo(url("?chainId=999&version=888"))
		expect(info.chainId.equals(new Fr(999))).toBe(true)
		expect(info.version.equals(new Fr(888))).toBe(true)
	})

	it("a partial override falls back to the constant for the missing field (DEV)", () => {
		const info = readChainInfo(url("?chainId=999"))
		expect(info.chainId.equals(new Fr(999))).toBe(true)
		expect(info.version.equals(new Fr(TESTNET_ROLLUP_VERSION))).toBe(true)
	})

	describe("production build (import.meta.env.DEV === false)", () => {
		afterEach(() => vi.unstubAllEnvs())

		// Layer 3 of the integrity fence: a prod visitor's ?chainId= must be inert. A stray override
		// here would let anyone repoint the wallet handshake away from the build's pinned identity.
		it("IGNORES the ?chainId=&version= override — falls back to the constants", () => {
			vi.stubEnv("DEV", false)
			const info = readChainInfo(url("?chainId=999&version=888"))
			expect(info.chainId.equals(new Fr(TESTNET_L1_CHAIN_ID))).toBe(true)
			expect(info.version.equals(new Fr(TESTNET_ROLLUP_VERSION))).toBe(true)
		})
	})
})
