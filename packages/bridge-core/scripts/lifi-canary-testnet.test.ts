import { privateKeyToAddress } from "viem/accounts"
import { describe, expect, it } from "vitest"
import { routedManifest } from "./lifi-canary-fixture"
import { assertWithinCaps, planCanaryRows } from "./lifi-canary-plan"
import { canaryEdge, canaryReads, SOURCE_CHAIN_ID, TESTNET_AMOUNTS, TESTNET_GAS_PER_ROW } from "./lifi-canary-testnet"

// A throwaway scalar, not a key anyone holds.
const KEY = `0x${"ab".repeat(32)}` as const
const ADDRESS = privateKeyToAddress(KEY)
const OTHER = `0x${"cb".repeat(20)}` as const

describe("canaryEdge", () => {
	it("gives a dry run an address and no signer, and holds the key in no property either way", () => {
		const m = routedManifest()
		const dry = canaryEdge(m, { dryRun: true }, { CANARY_PRIVATE_KEY: KEY }, null)
		expect(dry.signer).toBeUndefined()
		expect(dry.cfg.canary).toBe(ADDRESS)
		const reads = canaryReads(dry)
		for (const r of [reads.source, reads.ethereum])
			for (const write of ["sendTransaction", "writeContract", "signTypedData"]) expect(write in r).toBe(false)

		const live = canaryEdge(m, { dryRun: false }, { CANARY_PRIVATE_KEY: KEY }, ADDRESS)
		expect(live.signer?.address).toBe(ADDRESS)
		for (const edge of [dry, live])
			expect(JSON.stringify(edge, (_, v) => (typeof v === "bigint" ? v.toString() : v))).not.toContain(KEY.slice(2))
	})

	it("refuses a live run without CANARY_PRIVATE_KEY (PRIVATE_KEY is never read), without the pin, or off the pin", () => {
		const m = routedManifest()
		expect(() => canaryEdge(m, { dryRun: false }, { PRIVATE_KEY: KEY }, ADDRESS)).toThrow(/CANARY_PRIVATE_KEY, which is not set/)
		expect(() => canaryEdge(m, { dryRun: false }, { CANARY_PRIVATE_KEY: KEY }, null)).toThrow(/no canary address is pinned/)
		expect(() => canaryEdge(m, { dryRun: false }, { CANARY_PRIVATE_KEY: KEY }, OTHER)).toThrow(/not the pinned/)
		expect(() => canaryEdge(m, { dryRun: true }, { CANARY_PRIVATE_KEY: "0x12" }, null)).toThrow(/^(?!.*0x12).*not a 0x-prefixed/)
	})

	it("binds the intent's gas caps, and the testnet matrix fits them and the token caps", () => {
		const { cfg } = canaryEdge(routedManifest(), { dryRun: true, canary: OTHER }, {}, null)
		expect(cfg.caps.gasWei).toEqual({ source: 50_000_000_000_000_000n, ethereum: 200_000_000_000_000_000n })
		expect(() => assertWithinCaps(planCanaryRows(TESTNET_AMOUNTS), cfg.caps, SOURCE_CHAIN_ID, TESTNET_GAS_PER_ROW)).not.toThrow()
	})
})
