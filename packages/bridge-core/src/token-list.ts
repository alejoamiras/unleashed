/**
 * The token catalog behind "pick a token": a Uniswap-format list, fetched at most once a TTL,
 * validated, narrowed to one chain, and cached.
 *
 * Nothing here throws. A list is a convenience — the wizard always accepts a pasted address — so
 * every failure degrades to the cached catalog (however stale) and then to an empty one. The
 * remote body is hostile input: it is size-capped WHILE streaming, never redirected, checked against
 * a pinned SHA-256, and only the validated per-chain subset is persisted (the whole list is ~670 KB).
 */
import type { Address } from "viem"
import z from "zod"
import type { KV } from "./journal"

/**
 * Uniswap's default list, pinned to one npm version on jsDelivr, and the SHA-256 of that file.
 * `tokens.uniswap.org` redirects to the swap app. The digest comes from npm's own
 * tarball, verified against the registry's integrity, so the CDN's promise that an exact-version
 * path never changes is checked, not trusted. Bump both together, only to a version at least 7 days
 * old, and move the CSP pins with them (UPDATE.md).
 */
export const TOKEN_LIST_URL = "https://cdn.jsdelivr.net/npm/@uniswap/default-token-list@22.20.0/build/uniswap-default.tokenlist.json"
export const TOKEN_LIST_SHA256 = "b584e698c755e31fd112dcd29e26979640b2e5bddd123a8f4a45422a0c9edb4f"
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000
const DEFAULT_BYTE_CAP = 2 * 1024 * 1024
const DEFAULT_TOKEN_CAP = 2000
const DEFAULT_TIMEOUT_MS = 8_000

export const tokenListCacheKey = (chainId: number): string => `unleashed-bridge:token-list:v1:${chainId}`

/** Unknown keys (`tags`, `extensions`, …) are dropped rather than rejected — lists carry vendor extras. */
export const tokenListEntrySchema = z.object({
	chainId: z.number().int().positive(),
	address: z.string().regex(/^0x[0-9a-fA-F]{40}$/, "expected a 20-byte 0x hex address"),
	name: z.string(),
	symbol: z.string(),
	decimals: z.number().int().min(0).max(255),
	logoURI: z.string().optional(),
})

/**
 * Entries are validated one by one, AFTER the chain filter: a multi-chain list carries entries whose
 * shape is foreign to ours (Solana addresses on chain 501000101), and one such entry must not take
 * the whole catalog down with it. Only the entries on our chain are held to the entry schema; a
 * malformed one is dropped, never persisted.
 */
export const tokenListSchema = z.object({
	name: z.string(),
	tokens: z.array(z.unknown()),
})

/** The persisted shape: addresses are already lowercased, so the cache is read back byte-strict. */
export const catalogTokenSchema = tokenListEntrySchema.extend({
	address: z.string().regex(/^0x[0-9a-f]{40}$/, "expected a lowercase 20-byte 0x hex address"),
})

export const tokenListCacheSchema = z.object({
	fetchedAt: z.number().int().nonnegative(),
	chainId: z.number().int().positive(),
	tokens: z.array(catalogTokenSchema),
})

export interface CatalogToken {
	chainId: number
	/** Lowercase — the canonical key for lookups and de-duplication. */
	address: Address
	name: string
	symbol: string
	decimals: number
	logoURI?: string
}

export interface LoadTokenListOptions {
	chainId: number
	fetch: typeof fetch
	kv: KV
	now?: () => number
	ttlMs?: number
	/** The file to load and the SHA-256 digests its bytes may have; defaults to the pinned list. */
	list?: { url: string; sha256: readonly string[] }
	byteCap?: number
	tokenCap?: number
	timeoutMs?: number
}

/** `fresh` = fetched now; `cache` = an unexpired cache hit, no network; `fallback` = the fetch failed. */
export type TokenListProvenance = "fresh" | "cache" | "fallback"

interface TokenListCache {
	fetchedAt: number
	chainId: number
	tokens: CatalogToken[]
}

function readCache(kv: KV, key: string, chainId: number): TokenListCache | undefined {
	const raw = kv.getItem(key)
	if (raw === null) return undefined
	let json: unknown
	try {
		json = JSON.parse(raw)
	} catch {
		kv.removeItem(key)
		return undefined
	}
	const parsed = tokenListCacheSchema.safeParse(json)
	// A cache written for another chain is as untrustworthy as a malformed one — drop, don't reuse.
	if (!parsed.success || parsed.data.chainId !== chainId) {
		kv.removeItem(key)
		return undefined
	}
	return parsed.data as TokenListCache
}

function persist(kv: KV, key: string, cache: TokenListCache): void {
	try {
		kv.setItem(key, JSON.stringify(cache))
	} catch {
		// Quota (or a KV that refuses writes): the catalog stays memory-only for this session.
	}
}

async function readCapped(res: Response, byteCap: number, controller: AbortController): Promise<Uint8Array<ArrayBuffer>> {
	if (res.body === null) throw new Error("token list response had no body")
	const reader = res.body.getReader()
	const chunks: Uint8Array[] = []
	let seen = 0
	let chunk = await reader.read()
	while (chunk.done !== true) {
		seen += chunk.value.byteLength
		// The cap is enforced on the RUNNING total: a hostile origin never gets to hand us the
		// whole body and have us decide afterwards.
		if (seen > byteCap) {
			controller.abort()
			throw new Error("token list exceeded its byte cap")
		}
		chunks.push(chunk.value)
		chunk = await reader.read()
	}
	const bytes = new Uint8Array(seen)
	let offset = 0
	for (const part of chunks) {
		bytes.set(part, offset)
		offset += part.byteLength
	}
	return bytes
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))
	return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("")
}

const onChain = (entry: unknown, chainId: number): boolean =>
	typeof entry === "object" && entry !== null && (entry as { chainId?: unknown }).chainId === chainId

function narrow(entries: readonly unknown[], chainId: number, cap: number): CatalogToken[] {
	const tokens: CatalogToken[] = []
	const seen = new Set<string>()
	for (const raw of entries) {
		if (!onChain(raw, chainId)) continue
		const parsed = tokenListEntrySchema.safeParse(raw)
		if (!parsed.success) continue
		const entry = parsed.data
		const address = entry.address.toLowerCase() as Address
		if (seen.has(address)) continue
		seen.add(address)
		const token: CatalogToken = { chainId, address, name: entry.name, symbol: entry.symbol, decimals: entry.decimals }
		// Nothing renders the logo today (tiles are committed brand or grey marks); it is kept https-only
		// so no future renderer can ever receive anything else.
		if (entry.logoURI?.startsWith("https://")) token.logoURI = entry.logoURI
		tokens.push(token)
		if (tokens.length === cap) break
	}
	return tokens
}

async function fetchCatalog(o: LoadTokenListOptions): Promise<CatalogToken[]> {
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), o.timeoutMs ?? DEFAULT_TIMEOUT_MS)
	try {
		// `redirect: "error"` — a list that redirects is no longer the origin whose content we vetted.
		const pin = o.list ?? { url: TOKEN_LIST_URL, sha256: [TOKEN_LIST_SHA256] }
		const res = await o.fetch(pin.url, { redirect: "error", signal: controller.signal })
		if (!res.ok) throw new Error(`token list responded ${res.status}`)
		const bytes = await readCapped(res, o.byteCap ?? DEFAULT_BYTE_CAP, controller)
		if (!pin.sha256.includes(await sha256Hex(bytes))) throw new Error("token list does not match its pinned digest")
		const list = tokenListSchema.parse(JSON.parse(new TextDecoder().decode(bytes)))
		return narrow(list.tokens, o.chainId, o.tokenCap ?? DEFAULT_TOKEN_CAP)
	} finally {
		clearTimeout(timer)
	}
}

/**
 * Loads the catalog for one chain: unexpired cache, else network, else whatever cache exists, else
 * nothing. Never rejects.
 */
export async function loadTokenList(o: LoadTokenListOptions): Promise<{ tokens: CatalogToken[]; provenance: TokenListProvenance }> {
	const key = tokenListCacheKey(o.chainId)
	const now = o.now ?? Date.now
	const cached = readCache(o.kv, key, o.chainId)
	if (cached !== undefined && now() - cached.fetchedAt < (o.ttlMs ?? DEFAULT_TTL_MS)) {
		return { tokens: cached.tokens, provenance: "cache" }
	}
	try {
		const tokens = await fetchCatalog(o)
		persist(o.kv, key, { fetchedAt: now(), chainId: o.chainId, tokens })
		return { tokens, provenance: "fresh" }
	} catch {
		return { tokens: cached?.tokens ?? [], provenance: "fallback" }
	}
}
