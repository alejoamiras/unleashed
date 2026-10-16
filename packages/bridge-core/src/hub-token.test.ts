/**
 * KEYSTONE (TS leg): the hub-derived Token instance must equal the hub's in-circuit `derive_token`
 * (contracts/bridge/aztec/token_bridge_hub/src/test/keystone.nr) for the fixed vector. The class id
 * is the installed aztec-standards@6.0.0-rc.3 Token — the same pin as noir-artifact-classids.test.ts.
 */
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { describe, expect, it } from "vitest"
import { deriveHubTokenInstance, hubTokenSalt } from "./hub-token"

const HUB = AztecAddress.fromBigIntUnsafe(0x1234000000000000000000000000000000000000000000000000000000000abcn)
const ERC20 = "0x00000000000000000000000000000000000e2c20"
/** The installed aztec-standards@6.0.0-rc.3 Token class — the same pin as noir-artifact-classids.test.ts. */
const TOKEN_CLASS_ID = "0x163b2b247391083157f9fc30405e81810e6c08c58501fa2dd10de27d42be1d8a"
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
		expect(inst.address.toString()).toBe("0x1486166167759d2f698e0a95bed4da1d6f11d1c48a16f577c5079969e80ba750")
	})

	it("refuses a hub whose Token class is not the installed one", async () => {
		await expect(deriveHubTokenInstance(HUB, ERC20, WORDS, `0x${"1".repeat(64)}`)).rejects.toThrow("hub Token class mismatch")
	})
})
