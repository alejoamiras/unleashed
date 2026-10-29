import { readFileSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type Hex, keccak256 } from "viem"
import { describe, expect, it, vi } from "vitest"
import { START_BRIDGE_TOKENS_VIA_ACROSS_V4_SELECTOR, type LifiChainBook, parseManifestV2 } from "@unleashed/sdk/protocol"
import { judgeBook, type ObservedBook, verifyL1Manifest } from "./verify-l1"

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
	// Every check fails at once: viem does not retry "method not found", and its error text carries the RPC URL. The
	// routing source reads the same server and forge is absent, so the case reaches no network and builds nothing.
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
			vi.stubEnv("FORGE_BIN", join(tmpdir(), "absent-forge"))
			const live = join(import.meta.dirname, "..", "..", "..", "apps", "tools", "public", "testnet-bridge.json")
			const manifest = parseManifestV2(JSON.parse(readFileSync(live, "utf8")))
			const failures = await verifyL1Manifest(manifest, url, { sourceRpcUrl: () => url })
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
