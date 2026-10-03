/**
 * KEYSTONE (TS leg): the clone initcode + CREATE2 prediction must equal
 * `Clones.predictDeterministicAddressWithImmutableArgs` (test/Keystone.t.sol) for the fixed vector.
 */
import { describe, expect, it } from "vitest"
import { portalInitCode, portalSalt, predictPortal } from "./portal-address"

const FACTORY = "0x3333333333333333333333333333333333333333"
const IMPL = "0x1111111111111111111111111111111111111111"
const ERC20 = "0x2222222222222222222222222222222222222222"

describe("portal address keystone", () => {
	it("reproduces the OZ immutable-args clone initcode byte for byte", () => {
		expect(portalInitCode(IMPL, ERC20)).toBe(
			"0x6100413d81600a3d39f3363d3d373d3d3d363d7311111111111111111111111111111111111111115af43d82803e903d91602b57fd5bf32222222222222222222222222222222222222222",
		)
	})

	it("uses the plain-address salt", () => {
		expect(portalSalt(ERC20)).toBe("0x0000000000000000000000002222222222222222222222222222222222222222")
	})

	it("matches the Solidity prediction for the fixed vector", () => {
		expect(predictPortal(FACTORY, IMPL, ERC20)).toBe("0x9e4fc5082e41ec39a0d4a8b624a3baf3289c5eee")
	})

	it("refuses malformed addresses", () => {
		expect(() => predictPortal(FACTORY, IMPL, "0x22")).toThrow("erc20")
	})
})
