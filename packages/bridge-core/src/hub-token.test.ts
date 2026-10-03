/**
 * KEYSTONE (TS leg): the hub-derived Token instance must equal the hub's in-circuit `derive_token`
 * (contracts/bridge/aztec/token_bridge_hub/src/test/keystone.nr) for the fixed vector. The class id
 * is the installed aztec-standards@6.0.0-rc.1 Token — the same pin as noir-artifact-classids.test.ts.
 */
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { describe, expect, it } from "vitest"
import { deriveHubTokenInstance, hubTokenSalt } from "./hub-token"

const HUB = AztecAddress.fromBigIntUnsafe(0x1234000000000000000000000000000000000000000000000000000000000abcn)
const ERC20 = "0x00000000000000000000000000000000000e2c20"
/** The installed aztec-standards@6.0.0-rc.1 Token class — the same pin as noir-artifact-classids.test.ts. */
const TOKEN_CLASS_ID = "0x24c34002788720c941a327a20c369b12c8bdcff3b5a974673a8f618763471505"
const WORDS = {
	nameWord: "0x005465737420546f6b656e000000000000000000000000000000000000000000",
	symbolWord: "0x0054535400000000000000000000000000000000000000000000000000000000",
	decimals: 18,
}

describe("hub token keystone", () => {
	it("salts with the ERC-20 address", () => {
		expect(hubTokenSalt(ERC20).toString()).toBe("0x00000000000000000000000000000000000000000000000000000000000e2c20")
	})

	it("matches the hub's in-circuit derivation for the fixed vector", async () => {
		const inst = await deriveHubTokenInstance(HUB, ERC20, WORDS, TOKEN_CLASS_ID)
		expect(inst.currentContractClassId.toString()).toBe(TOKEN_CLASS_ID)
		expect(inst.deployer.equals(HUB)).toBe(true)
		expect(inst.address.toString()).toBe("0x058925d9258a1d0fcb8dde2076aae996ed03c1d6dc25dfa2562c8bef4ca01fd2")
	})

	it("refuses a hub whose Token class is not the installed one", async () => {
		await expect(deriveHubTokenInstance(HUB, ERC20, WORDS, `0x${"1".repeat(64)}`)).rejects.toThrow("hub Token class mismatch")
	})
})
