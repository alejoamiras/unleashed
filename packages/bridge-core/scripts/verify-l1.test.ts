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
		const deployed = runtime(DEPLOYED, 0x11)
		// The chain's own length word is ignored: the mask is bounded by the build alone.
		deployed.set([0xff, 0xff], deployed.length - 2)
		const { onChain, built } = maskedRuntimeHashes(deployed, runtime(CODE, 0x22), REFS)
		expect(onChain).toBe(built)
	})

	it("fails on a single changed byte of code before the trailer, or any difference in length", () => {
		// POP, and the INVALID guard right before the trailer.
		for (const index of [33, 35]) {
			const tampered = runtime(DEPLOYED, 0x11)
			tampered[index] = 0x00
			const { onChain, built } = maskedRuntimeHashes(tampered, runtime(CODE, 0x22), REFS)
			expect(onChain).not.toBe(built)
		}
		// Bytes past the build's length would fall inside the masked tail.
		const extended = Uint8Array.from([...runtime(DEPLOYED, 0x11), 0x00])
		expect(() => maskedRuntimeHashes(extended, runtime(CODE, 0x22), REFS)).toThrow(/length 90 != build 89/)
	})

	it("refuses a build whose trailer length is bogus instead of masking code", () => {
		const overlong = runtime(CODE, 0x22)
		overlong.set([0xff, 0xff], overlong.length - 2)
		expect(() => maskedRuntimeHashes(overlong, overlong, REFS)).toThrow(/metadata trailer is malformed/)
		// In range, but pointing into code rather than at a CBOR map.
		const intoCode = runtime(CODE, 0x22)
		intoCode.set([0x00, intoCode.length - 3], intoCode.length - 2)
		expect(() => maskedRuntimeHashes(intoCode, intoCode, REFS)).toThrow(/metadata trailer is malformed/)
	})
})
