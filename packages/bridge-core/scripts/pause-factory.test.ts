import { getAddress } from "viem"
import { describe, expect, it } from "vitest"
import type { ManifestV2 } from "../src/manifest-v2"
import { planPause } from "./pause-factory"

const FACTORY = "0x00000000000000000000000000000000000fac70"
const SIGNER = "0x000000000000000000000000000000000000beef"
const manifest = (over: Partial<ManifestV2> = {}) =>
	({ network: "testnet", l1ChainId: 11155111, bridge: { l1: { factory: FACTORY } }, ...over }) as ManifestV2

const plan = (over: Partial<Parameters<typeof planPause>[0]> = {}) =>
	planPause({
		manifest: manifest(),
		argv: ["--factory", FACTORY, "--deposits", "paused"],
		signer: SIGNER,
		pinnedSigner: getAddress(SIGNER),
		owner: SIGNER,
		nonces: { finalized: 7, pending: 7 },
		current: { deposits: false, withdraws: false },
		...over,
	})

describe("planPause", () => {
	it("pauses deposits and carries the withdraw bit over untouched", () => {
		expect(plan()).toEqual({ factory: getAddress(FACTORY), next: { deposits: true, withdraws: false }, needed: true, nonce: 7 })
		expect(plan({ current: { deposits: false, withdraws: true } }).next).toEqual({ deposits: true, withdraws: true })
		expect(plan({ argv: ["--factory", FACTORY, "--deposits", "open"], current: { deposits: true, withdraws: true } }).next).toEqual({
			deposits: false,
			withdraws: true,
		})
	})

	it("sends nothing when the chain already holds the requested state", () => {
		expect(plan({ current: { deposits: true, withdraws: false } }).needed).toBe(false)
	})

	it("refuses a factory the manifest does not name, and a request that names none", () => {
		expect(() => plan({ argv: ["--factory", SIGNER, "--deposits", "paused"] })).toThrow(/not the manifest's factory/)
		expect(() => plan({ argv: ["--deposits", "paused"] })).toThrow(/--factory <address> is required/)
		expect(() => plan({ argv: ["--factory", FACTORY] })).toThrow(/--deposits paused\|open/)
	})

	it("refuses a signer that is not both the pinned signer and the owner", () => {
		expect(() => plan({ pinnedSigner: FACTORY })).toThrow(/not the pinned testnet signer/)
		expect(() => plan({ owner: FACTORY })).toThrow(/not the factory's owner/)
	})

	it("refuses while a transaction of the signer is not yet finalized, which could change the bit it carries over", () => {
		expect(() => plan({ nonces: { finalized: 7, pending: 8 } })).toThrow(/1 transaction\(s\) not yet finalized/)
	})

	it("refuses anything but a Sepolia testnet manifest", () => {
		expect(() => plan({ manifest: manifest({ network: "mainnet", l1ChainId: 1 } as Partial<ManifestV2>) })).toThrow(/testnet only/)
		expect(() => plan({ manifest: manifest({ l1ChainId: 1 } as Partial<ManifestV2>) })).toThrow(/testnet only/)
	})
})
