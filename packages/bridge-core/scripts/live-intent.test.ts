import { describe, expect, it } from "vitest"
import { assertL1Pins, assertNoSourceDrift, type NodeIdentity } from "./live-intent"

const pinned = {
	rollup: "0x8c2fb2a68a3d362ab1de99e06f83f8903160bbd9",
	feeJuicePortal: "0x5bb7523a95c1fdf1d2a3dd9fb7d497e7f5142d7f",
	feeJuice: "0x762c132040fda6183066fa3b14d985ee55aa3c18",
	feeAssetHandler: "0x5602c39a6e9c5ace589f64f754927bcda4f4bfc9",
	registry: "0xa0bfb1b494fb49041e5c6e8c2c1be09cd171c6ba",
}
const node = (registryAddress: string): NodeIdentity => ({
	nodeVersion: "6.0.0-rc.1",
	l1ChainId: 11155111,
	rollupVersion: 2914217885,
	l1ContractAddresses: {
		rollupAddress: "0x8C2FB2A68A3D362AB1DE99E06F83F8903160BBD9",
		feeJuicePortalAddress: pinned.feeJuicePortal,
		feeJuiceAddress: pinned.feeJuice,
		feeAssetHandlerAddress: pinned.feeAssetHandler,
		registryAddress,
	},
})

describe("assertL1Pins", () => {
	it("accepts a node whose five L1 addresses equal the pins, case aside", () => {
		expect(() => assertL1Pins(node(pinned.registry), pinned, "intent")).not.toThrow()
	})

	it("refuses a node that substitutes only the registry", () => {
		expect(() => assertL1Pins(node(`0x${"ab".repeat(20)}`), pinned, "intent")).toThrow(/registry .* != intent/)
	})
})

describe("assertNoSourceDrift", () => {
	const source = (commit: string) => ({ source: { commit, treeClean: true, operationalAllowlist: [] } })

	it("refuses an intent that records no build commit, or a malformed one", () => {
		expect(() => assertNoSourceDrift(source(""))).toThrow(/source\.commit is empty/)
		expect(() => assertNoSourceDrift({} as never)).toThrow(/source\.commit is empty/)
		expect(() => assertNoSourceDrift(source("HEAD"))).toThrow(/not a 40-hex commit/)
	})
})
