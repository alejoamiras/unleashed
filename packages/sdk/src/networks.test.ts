import { describe, expect, it } from "vitest"
import { fuelRouteOf } from "./execution/send-generation.ts"
import { bundledManifest, MAINNET_MANIFEST, TESTNET_MANIFEST } from "./networks.ts"
import { SANDBOX_LIFI_CHAIN_IDS } from "./protocol/lifi-addresses.ts"
import { parseManifestV2 } from "./protocol/manifest-v2.ts"

describe("the bundled networks", () => {
	const bundled = [TESTNET_MANIFEST, MAINNET_MANIFEST].map((m) => parseManifestV2(m))

	it("bundle one network per chain, none of them a sandbox's", () => {
		for (const m of bundled) {
			expect(SANDBOX_LIFI_CHAIN_IDS).not.toContain(m.l1ChainId)
			expect(parseManifestV2(bundledManifest(m.l1ChainId))).toEqual(m)
		}
		expect(new Set(bundled.map((m) => m.l1ChainId)).size).toBe(bundled.length)
		expect(bundledManifest(8453)).toBeUndefined()
	})

	// A gas route without a testnet swapper quotes through LI.FI, which this release refuses on live chains.
	it("on live chains route gas through no LI.FI venue", () => {
		for (const m of bundled) {
			const route = fuelRouteOf(m)
			expect(route === undefined || route.fuelSwapper !== undefined, m.network).toBe(true)
		}
	})
})
