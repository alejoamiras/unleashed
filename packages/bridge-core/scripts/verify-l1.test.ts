import { concat, type Hex, hexToBytes, toHex } from "viem"
import { describe, expect, it } from "vitest"
import { maskedRuntimeHashes } from "./verify-l1"

/** A runtime laid out as solc emits it: code, an INVALID guard, then the CBOR metadata map
 *  `{ipfs: <34 bytes>, solc: <3 bytes>}` and its 2-byte length. */
function runtime(code: Hex, ipfsByte: number): Uint8Array {
	const cbor = concat(["0xa264697066735822", toHex(new Uint8Array(34).fill(ipfsByte)), "0x64736f6c634300081c"])
	return hexToBytes(concat([code, "0xfe", cbor, toHex((cbor.length - 2) / 2, { size: 2 })]))
}

// PUSH32 <immutable> POP STOP: the immutable occupies bytes 1..32.
const CODE = `0x7f${"00".repeat(32)}5000` as Hex
const DEPLOYED = `0x7f${"ab".repeat(32)}5000` as Hex
const REFS = { "7": [{ start: 1, length: 32 }] }

describe("maskedRuntimeHashes", () => {
	it("matches a deployment that differs from the build only in its immutables and metadata trailer", () => {
		const { onChain, built } = maskedRuntimeHashes(runtime(DEPLOYED, 0x11), runtime(CODE, 0x22), REFS)
		expect(onChain).toBe(built)
	})

	it("fails on a single changed byte of code before the trailer", () => {
		const tampered = runtime(DEPLOYED, 0x11)
		tampered[33] = 0x00 // POP → STOP
		const { onChain, built } = maskedRuntimeHashes(tampered, runtime(CODE, 0x22), REFS)
		expect(onChain).not.toBe(built)
	})

	it("refuses a build whose trailer length is bogus instead of masking code", () => {
		const overlong = runtime(CODE, 0x22)
		overlong.set([0xff, 0xff], overlong.length - 2)
		expect(() => maskedRuntimeHashes(overlong, overlong, REFS)).toThrow(/metadata trailer is malformed/)
		// In range, but pointing into code rather than at a CBOR map.
		const intoCode = runtime(CODE, 0x22)
		intoCode.set([0x00, intoCode.length - 2], intoCode.length - 2)
		expect(() => maskedRuntimeHashes(intoCode, intoCode, REFS)).toThrow(/metadata trailer is malformed/)
	})
})
