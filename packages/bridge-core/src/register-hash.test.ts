/**
 * KEYSTONE (TS leg): the `register` content hash and the public registration secret hash must
 * byte-match the Solidity `PortalFactory` (test/Keystone.t.sol) and the Noir `register_hash_lib`
 * (contracts/bridge/aztec/keystone) for the SAME fixed vectors.
 */
import { describe, expect, it } from "vitest"
import {
	fromWord,
	REGISTER_SECRET,
	REGISTER_SELECTOR,
	registerContentHash,
	registerSecretHash,
	sanitizeWordBytes,
	toWord,
	utf8,
	wordToNoirString,
} from "./register-hash"

const TOKEN = "0x00000000000000000000000000000000000e2c20"
const PORTAL = "0x00000000000000000000000000000000009017a1"
const NAME_WORD = "0x005465737420546f6b656e000000000000000000000000000000000000000000"
const SYMBOL_WORD = "0x0054535400000000000000000000000000000000000000000000000000000000"

describe("register keystone", () => {
	it("pins the selector (cast sig)", () => {
		expect(REGISTER_SELECTOR).toBe("0xfbc7d0f1")
	})

	it("encodes names as 0x00 ‖ 31 sanitized bytes", () => {
		expect(toWord(utf8("Test Token"))).toBe(NAME_WORD)
		expect(toWord(utf8("TST"))).toBe(SYMBOL_WORD)
		expect(fromWord(NAME_WORD)).toBe("Test Token")
		expect(wordToNoirString(SYMBOL_WORD)).toHaveLength(31)
	})

	it("sanitizes like the factory: printable ASCII only, `_` elsewhere, 31 bytes max", () => {
		expect(Array.from(sanitizeWordBytes(utf8("AéB\n")))).toEqual([0x41, 0x5f, 0x5f, 0x42, 0x5f]) // é is 2 UTF-8 bytes
		// A lone invalid byte is ONE underscore on chain; a decoded string would have made it three.
		expect(Array.from(sanitizeWordBytes(new Uint8Array([0xff, 0x41])))).toEqual([0x5f, 0x41])
		expect(sanitizeWordBytes(utf8("x".repeat(40)))).toHaveLength(31)
		expect(fromWord(toWord(utf8("Tab\there")))).toBe("Tab_here")
	})

	it("matches the Solidity + Noir register hash for the fixed vector", async () => {
		expect(await registerContentHash(TOKEN, PORTAL, NAME_WORD, SYMBOL_WORD, 18)).toBe(
			"0x008c135ab10d3a0b9e221b83dd074a9051612d8bc8a8f6b2330960ba6e8dbda3",
		)
	})

	it("pins the public registration secret hash (compute_secret_hash([0]))", async () => {
		expect(REGISTER_SECRET).toBe(0n)
		expect((await registerSecretHash()).toString()).toBe("0x1f8eff65d91ed781c2e7a28a2ff99b7f7506b7293121b5ffcf3cd339c84d2250")
	})

	it("rejects a non-uint8 decimals before hashing", () => {
		expect(() => registerContentHash(TOKEN, PORTAL, NAME_WORD, SYMBOL_WORD, 256)).toThrow("uint8")
	})
})
