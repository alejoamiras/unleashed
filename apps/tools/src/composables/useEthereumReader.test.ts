import { afterEach, describe, expect, it, vi } from "vitest"
import { __resetReadClientsForTests, discoveryReadsFor, readClientFor } from "./useEthereumReader"

const BASE_SEPOLIA = 84532
const SEPOLIA = 11155111

afterEach(() => {
	vi.unstubAllGlobals()
	__resetReadClientsForTests()
})

/** A JSON-RPC endpoint per URL: a number answers `eth_chainId`, "down" answers 503. */
function stubRpcs(answers: Record<string, number | "down">): string[] {
	const asked: string[] = []
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input instanceof Request ? input.url : input).replace(/\/$/, "")
			asked.push(url)
			const answer = answers[url]
			if (answer === undefined || answer === "down") return new Response("unavailable", { status: 503 })
			const { id } = JSON.parse(String(init?.body)) as { id: number }
			return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: `0x${answer.toString(16)}` }), {
				headers: { "content-type": "application/json" },
			})
		}),
	)
	return asked
}

describe("readClientFor — reads that need no wallet", () => {
	it("reads a source chain through its pinned RPCs, the next one when the first is down", async () => {
		const asked = stubRpcs({ "https://base-sepolia-rpc.publicnode.com": "down", "https://sepolia.base.org": BASE_SEPOLIA })
		const client = readClientFor(BASE_SEPOLIA)
		expect(client?.chain?.id).toBe(BASE_SEPOLIA)
		await expect(client?.getChainId()).resolves.toBe(BASE_SEPOLIA)
		expect(asked[0]).toBe("https://base-sepolia-rpc.publicnode.com")
		expect(asked.at(-1)).toBe("https://sepolia.base.org")
		expect(readClientFor(BASE_SEPOLIA)).toBe(client)
	})

	it("has no reader for a chain the build pins no RPC for, rather than borrowing the wallet's", () => {
		// Base mainnet is a known source, but the testnet build pins no read RPC for it.
		expect(readClientFor(8453)).toBeUndefined()
		expect(readClientFor(1)).toBeUndefined()
		expect(discoveryReadsFor(8453)).toBeUndefined()
		expect(discoveryReadsFor(BASE_SEPOLIA)).toBeDefined()
		expect(readClientFor(SEPOLIA)?.chain?.id).toBe(SEPOLIA)
	})
})
