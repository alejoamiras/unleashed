import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { describe, expect, it } from "vitest"
import { DEPLOYMENT_RECORDS, DRIPPER, NOISE, SIGNAL } from "./deployments"

describe("deployments.json invariants", () => {
	it("dripper address parses as AztecAddress and is non-zero", () => {
		expect(DRIPPER).toBeInstanceOf(AztecAddress)
		expect(DRIPPER.equals(AztecAddress.ZERO)).toBe(false)
	})

	it("SIGNAL and NOISE addresses parse and differ from each other and the dripper", () => {
		expect(SIGNAL).toBeInstanceOf(AztecAddress)
		expect(NOISE).toBeInstanceOf(AztecAddress)
		expect(SIGNAL.equals(DRIPPER)).toBe(false)
		expect(NOISE.equals(DRIPPER)).toBe(false)
		expect(SIGNAL.equals(NOISE)).toBe(false)
	})

	it("every token's minter equals the dripper address", () => {
		for (const record of [DEPLOYMENT_RECORDS.signal, DEPLOYMENT_RECORDS.noise]) {
			const minter = AztecAddress.fromStringUnsafe(record.constructorArgs.minter)
			expect(minter.equals(DRIPPER)).toBe(true)
		}
	})

	it("SIGNAL has decimals=6 and NOISE has decimals=18 (and constructor_with_minter for both)", () => {
		expect(DEPLOYMENT_RECORDS.signal.constructorArgs.decimals).toBe(6)
		expect(DEPLOYMENT_RECORDS.noise.constructorArgs.decimals).toBe(18)
		expect(DEPLOYMENT_RECORDS.signal.constructorArtifact).toBe("constructor_with_minter")
		expect(DEPLOYMENT_RECORDS.noise.constructorArtifact).toBe("constructor_with_minter")
	})

	it("dripper record uses the parameterless constructor (no minter on the dripper itself)", () => {
		expect(DEPLOYMENT_RECORDS.dripper.constructorArtifact).toBe("constructor")
	})

	// Address derivation needs bb.js's WASM hasher, which jsdom cannot boot: it is tested under the
	// node environment in deployments-records.test.ts.
})
