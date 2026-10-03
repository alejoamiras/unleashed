import { createHash } from "node:crypto"
import { describe, expect, it, vi } from "vitest"
import type { KV } from "./journal"
import { loadTokenList, tokenListCacheKey } from "./token-list"

const CHAIN = 11_155_111
const KEY = tokenListCacheKey(CHAIN)
const LIST_URL = "https://example.invalid/list.json"

function memoryKv(seed: Record<string, string> = {}): KV & { store: Map<string, string>; removed: string[] } {
	const store = new Map(Object.entries(seed))
	const removed: string[] = []
	return {
		store,
		removed,
		getItem: (k) => store.get(k) ?? null,
		setItem: (k, v) => void store.set(k, v),
		removeItem: (k) => {
			removed.push(k)
			store.delete(k)
		},
	}
}

const entry = (address: string, over: Record<string, unknown> = {}) => ({
	chainId: CHAIN,
	address,
	name: `Token ${address.slice(2, 6)}`,
	symbol: "TKN",
	decimals: 18,
	...over,
})

const A = "0xAAaAaAaaAaAaAaaAaAAAAAAAAaaAaAaAaAaAaaAa"
const B = "0xbBbBBBBbbBBBbbbBbbBbbbbbBBbBbbbbBbBbbBBb"

/** A `Response` whose body only materializes chunk by chunk, so a byte cap can bite mid-stream. */
function streamResponse(body: string, opts: { status?: number; chunkSize?: number; pulls?: { count: number } } = {}): Response {
	const bytes = new TextEncoder().encode(body)
	const chunkSize = opts.chunkSize ?? bytes.length
	let offset = 0
	const stream = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (opts.pulls) opts.pulls.count++
			if (offset >= bytes.length) return controller.close()
			controller.enqueue(bytes.slice(offset, offset + chunkSize))
			offset += chunkSize
		},
	})
	return new Response(stream, { status: opts.status ?? 200 })
}

const listBody = (tokens: unknown[]) => JSON.stringify({ name: "Test List", tokens })

const fetchReturning = (make: () => Response) => vi.fn(async () => make()) as unknown as typeof fetch

/** Serves `body` as the list, pinned to its own digest, so a test reaches the stage it is about. */
const serve = (body: string, opts: Parameters<typeof streamResponse>[1] = {}) => ({
	fetch: fetchReturning(() => streamResponse(body, opts)),
	list: { url: LIST_URL, sha256: [createHash("sha256").update(body).digest("hex")] },
})

const cacheEntry = (fetchedAt: number, tokens: Record<string, unknown>[], chainId = CHAIN) =>
	JSON.stringify({ fetchedAt, chainId, tokens: tokens.map((t) => ({ chainId, decimals: 18, name: "Cached", symbol: "CACHE", ...t })) })

describe("loadTokenList", () => {
	it("fetches, narrows to the chain, and persists only the validated subset", async () => {
		const kv = memoryKv()
		const result = await loadTokenList({
			chainId: CHAIN,
			...serve(listBody([entry(A), entry(B, { chainId: 1 })])),
			kv,
			now: () => 1_000,
		})

		expect(result.provenance).toBe("fresh")
		expect(result.tokens).toEqual([{ chainId: CHAIN, address: A.toLowerCase(), name: "Token AAaA", symbol: "TKN", decimals: 18 }])
		expect(JSON.parse(kv.store.get(KEY) as string)).toEqual({ fetchedAt: 1_000, chainId: CHAIN, tokens: result.tokens })
	})

	it("passes redirect:error and an abort signal to fetch", async () => {
		const served = serve(listBody([]))
		await loadTokenList({ chainId: CHAIN, ...served, kv: memoryKv() })
		const [url, init] = vi.mocked(served.fetch).mock.calls[0] as [string, RequestInit]
		expect(url).toBe(LIST_URL)
		expect(init.redirect).toBe("error")
		expect(init.signal).toBeInstanceOf(AbortSignal)
	})

	it("refuses a body that does not match the pinned digest and persists nothing", async () => {
		const kv = memoryKv()
		const served = serve(listBody([entry(A)]))
		const tampered = { ...served, fetch: fetchReturning(() => streamResponse(listBody([entry(B)]))) }
		const result = await loadTokenList({ chainId: CHAIN, ...tampered, kv })

		expect(result).toEqual({ tokens: [], provenance: "fallback" })
		expect(kv.store.has(KEY)).toBe(false)
	})

	it("serves an unexpired cache without touching the network", async () => {
		const kv = memoryKv({ [KEY]: cacheEntry(1_000, [{ address: A.toLowerCase() }]) })
		const fetchImpl = fetchReturning(() => streamResponse(listBody([])))
		const result = await loadTokenList({ chainId: CHAIN, fetch: fetchImpl, kv, now: () => 2_000, ttlMs: 5_000 })

		expect(result.provenance).toBe("cache")
		expect(result.tokens).toHaveLength(1)
		expect(fetchImpl).not.toHaveBeenCalled()
	})

	it("refetches once the cache is older than the ttl", async () => {
		const kv = memoryKv({ [KEY]: cacheEntry(1_000, [{ address: A.toLowerCase() }]) })
		const result = await loadTokenList({ chainId: CHAIN, ...serve(listBody([entry(B)])), kv, now: () => 9_000, ttlMs: 5_000 })

		expect(result.provenance).toBe("fresh")
		expect(result.tokens[0]?.address).toBe(B.toLowerCase())
	})

	it("aborts mid-stream once the byte cap is exceeded and falls back to the stale cache", async () => {
		const kv = memoryKv({ [KEY]: cacheEntry(0, [{ address: A.toLowerCase() }]) })
		const pulls = { count: 0 }
		const body = listBody(Array.from({ length: 40 }, (_, i) => entry(`0x${String(i).padStart(40, "0")}`)))
		const result = await loadTokenList({ chainId: CHAIN, ...serve(body, { chunkSize: 64, pulls }), kv, now: () => 1e9, byteCap: 200 })

		expect(result.provenance).toBe("fallback")
		expect(result.tokens[0]?.address).toBe(A.toLowerCase())
		// The cap bit while streaming: far fewer pulls than the body needs to drain.
		expect(pulls.count).toBeLessThan(body.length / 64)
	})

	it("falls back with an empty catalog on a non-2xx response", async () => {
		const kv = memoryKv()
		const served = serve(listBody([entry(A)]), { status: 503 })
		expect(await loadTokenList({ chainId: CHAIN, ...served, kv })).toEqual({ tokens: [], provenance: "fallback" })
	})

	it("falls back when the body is not a token list at all", async () => {
		const kv = memoryKv()
		const served = serve(JSON.stringify({ name: "No tokens key" }))
		expect((await loadTokenList({ chainId: CHAIN, ...served, kv })).provenance).toBe("fallback")
		expect(kv.store.has(KEY)).toBe(false)
	})

	it("drops a malformed entry on our chain and ignores foreign-chain shapes entirely", async () => {
		const kv = memoryKv()
		const solana = {
			chainId: 501_000_101,
			address: "5mbK36SZ7J19An8jFochhQS4of8g6BwUjbeCSxBSoWdp",
			name: "michi",
			symbol: "$MICHI",
			decimals: 6,
		}
		const body = listBody([solana, entry(A, { decimals: 999 }), entry(B)])
		const result = await loadTokenList({ chainId: CHAIN, ...serve(body), kv })

		expect(result.provenance).toBe("fresh")
		expect(result.tokens.map((t) => t.address)).toEqual([B.toLowerCase()])
	})

	it("drops a poisoned cache and refetches instead of serving it", async () => {
		const kv = memoryKv({ [KEY]: cacheEntry(1_000, [{ address: "not-an-address" }]) })
		const result = await loadTokenList({ chainId: CHAIN, ...serve(listBody([entry(A)])), kv, now: () => 1_000 })

		expect(kv.removed).toEqual([KEY])
		expect(result.provenance).toBe("fresh")
	})

	it("drops a cache written for another chain", async () => {
		const kv = memoryKv({ [KEY]: cacheEntry(1_000, [{ address: A.toLowerCase() }], 1) })
		const fetchImpl = fetchReturning(() => streamResponse("boom", { status: 500 }))
		const result = await loadTokenList({ chainId: CHAIN, fetch: fetchImpl, kv, now: () => 1_000 })

		expect(kv.removed).toEqual([KEY])
		expect(result).toEqual({ tokens: [], provenance: "fallback" })
	})

	it("still serves fresh tokens when the store refuses the write", async () => {
		const kv = memoryKv()
		kv.setItem = () => {
			throw new Error("QuotaExceededError")
		}
		const result = await loadTokenList({ chainId: CHAIN, ...serve(listBody([entry(A)])), kv })

		expect(result.provenance).toBe("fresh")
		expect(result.tokens).toHaveLength(1)
	})

	it("de-duplicates by lowercased address (first wins) and caps the catalog", async () => {
		const kv = memoryKv()
		const body = listBody([
			entry(A, { symbol: "FIRST" }),
			entry(A.toLowerCase(), { symbol: "DUPE" }),
			entry(B),
			entry(`${A.slice(0, 41)}1`),
		])
		const result = await loadTokenList({ chainId: CHAIN, ...serve(body), kv, tokenCap: 2 })

		expect(result.tokens.map((t) => t.symbol)).toEqual(["FIRST", "TKN"])
		expect(result.tokens.map((t) => t.address)).toEqual([A.toLowerCase(), B.toLowerCase()])
	})

	it("keeps only https logos — anything else is dropped rather than rendered", async () => {
		const kv = memoryKv()
		const body = listBody([entry(A, { logoURI: "https://cdn.example/a.png" }), entry(B, { logoURI: "javascript:alert(1)" })])
		const result = await loadTokenList({ chainId: CHAIN, ...serve(body), kv })
		expect(result.tokens.map((t) => t.logoURI)).toEqual(["https://cdn.example/a.png", undefined])
	})
})

/**
 * The real list, opt-in: `TOKEN_LIST_LIVE=1`. The pinned file answers, matches its digest, narrows
 * to exactly its two Sepolia entries, and a second load is served from the cache without a request.
 * The digest fixes the content, so membership is asserted; a version bump updates the pair.
 */
describe.skipIf(!process.env.TOKEN_LIST_LIVE)("loadTokenList against the real list", () => {
	it("fetches the pinned Sepolia entries fresh, then serves the cache", async () => {
		const kv = memoryKv()
		const calls = { count: 0 }
		const counting: typeof fetch = (input, init) => {
			calls.count++
			return fetch(input, init)
		}
		const first = await loadTokenList({ chainId: CHAIN, fetch: counting, kv })

		expect(first.provenance).toBe("fresh")
		expect(first.tokens.map((t) => [t.symbol, t.address])).toEqual([
			["UNI", "0x1f9840a85d5af5bf1d1762f925bdaddc4201f984"],
			["WETH", "0xfff9976782d46cc05630d1f6ebab18b2324d6b14"],
		])

		const second = await loadTokenList({ chainId: CHAIN, fetch: counting, kv })
		expect(second.provenance).toBe("cache")
		expect(second.tokens).toEqual(first.tokens)
		expect(calls.count).toBe(1)
	}, 30_000)
})
