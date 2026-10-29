import { readFileSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { join } from "node:path"
import { concat, type Hex, hexToBytes, keccak256, toHex } from "viem"
import { describe, expect, it, vi } from "vitest"
import { START_BRIDGE_TOKENS_VIA_ACROSS_V4_SELECTOR } from "../src/across-v4"
import type { LifiChainBook } from "../src/lifi-addresses"
import { parseManifestV2 } from "../src/manifest-v2"
import { judgeBook, maskedRuntimeHashes, type ObservedBook, verifyL1Manifest } from "./verify-l1"

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

	it("with no immutables recorded, matches an exact deployment and fails one carrying immutables", () => {
		const exact = maskedRuntimeHashes(runtime(CODE, 0x11), runtime(CODE, 0x22), {})
		expect(exact.onChain).toBe(exact.built)
		const unmasked = maskedRuntimeHashes(runtime(DEPLOYED, 0x11), runtime(CODE, 0x22), {})
		expect(unmasked.onChain).not.toBe(unmasked.built)
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

describe("judgeBook", () => {
	const at = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as const
	const codeOf = (n: number) => `0x60${n.toString(16).padStart(2, "0")}` as Hex
	const SELECTOR = "0x4666fc80"
	const BRIDGE = START_BRIDGE_TOKENS_VIA_ACROSS_V4_SELECTOR
	const book: LifiChainBook = {
		chainId: 84532,
		diamond: at(1),
		executor: at(2),
		receiverAcrossV4: at(3),
		feeForwarder: at(4),
		facets: { [SELECTOR]: at(5), [BRIDGE]: at(8) },
		acrossSpokePool: at(6),
		codeHashes: { executor: keccak256(codeOf(2)), receiverAcrossV4: keccak256(codeOf(3)), feeForwarder: keccak256(codeOf(4)) },
	}
	const seen = (over: Partial<ObservedBook> = {}): ObservedBook => ({
		chainId: 84532,
		code: Object.fromEntries([1, 2, 3, 4, 6].map((n) => [at(n), codeOf(n)])),
		facets: { [SELECTOR]: at(5), [BRIDGE]: at(8) },
		...over,
	})
	const notOk = (o: ObservedBook) => judgeBook(book, o).flatMap((f) => (f.level === "ok" ? [] : [`${f.level} ${f.label}`]))

	it("passes the pinned book; fails a changed periphery, missing code, another chain or a moved bridge facet; warns on a moved swap facet", () => {
		expect(notOk(seen())).toEqual([])
		expect(notOk(seen({ code: { ...seen().code, [at(2)]: codeOf(9) } }))).toEqual([
			"fail LI.FI book (chain 84532) executor runtime code hash",
		])
		expect(notOk(seen({ code: { ...seen().code, [at(6)]: "0x" } }))).toEqual(["fail LI.FI book (chain 84532) code at acrossSpokePool"])
		expect(notOk(seen({ chainId: 11155111 }))).toEqual(["fail LI.FI book (chain 84532) chain id"])
		expect(notOk(seen({ facets: { [SELECTOR]: at(7), [BRIDGE]: at(8) } }))).toEqual([
			`warn LI.FI book (chain 84532) facet behind ${SELECTOR}`,
		])
		expect(notOk(seen({ facets: { [SELECTOR]: at(5), [BRIDGE]: at(7) } }))).toEqual([
			`fail LI.FI book (chain 84532) facet behind ${BRIDGE}`,
		])
	})
})

describe("verifyL1Manifest's printed failures", () => {
	// Every check fails at once: viem does not retry "method not found", and its error text carries the RPC URL.
	it("name the keyed L1 RPC, never its URL", async () => {
		const key = "sentinel_Key-0123456789"
		const server = createServer((req, res) => {
			let body = ""
			req.on("data", (chunk) => {
				body += chunk
			})
			req.on("end", () => {
				const reply = (call: { id?: unknown }) => ({
					jsonrpc: "2.0",
					id: call.id ?? null,
					error: { code: -32601, message: "method not found" },
				})
				const calls = JSON.parse(body) as { id?: unknown } | { id?: unknown }[]
				res.setHeader("content-type", "application/json")
				res.end(JSON.stringify(Array.isArray(calls) ? calls.map(reply) : reply(calls)))
			})
		})
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
		const printed: string[] = []
		const spies = (["log", "warn", "error"] as const).map((level) =>
			vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
				printed.push(args.join(" "))
			}),
		)
		try {
			const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/${key}`
			vi.stubEnv("SEPOLIA_RPC_URL", url)
			const live = join(import.meta.dirname, "..", "..", "..", "apps", "tools", "public", "testnet-bridge.json")
			const failures = await verifyL1Manifest(parseManifestV2(JSON.parse(readFileSync(live, "utf8"))), url)
			expect(failures > 0, "the checks failed").toBe(true)
			expect(printed.some((line) => line.includes("<SEPOLIA_RPC_URL>"))).toBe(true)
			expect(printed.some((line) => line.includes(key))).toBe(false)
		} finally {
			for (const spy of spies) spy.mockRestore()
			vi.unstubAllEnvs()
			server.close()
		}
	})
})
