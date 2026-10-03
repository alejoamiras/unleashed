/**
 * The tokens the send wizard offers: the generation's own, a remote community list, and whatever
 * the user pastes. Nothing here touches a chain — a catalog entry is only a candidate, and the
 * selection step is what turns one into a token with state, words and balances.
 */
import { type CatalogToken, type KV, loadTokenList, TOKEN_LIST_URL, type TokenListProvenance } from "@unleashed/bridge-core"
import type { Address } from "viem"
import { computed, type ComputedRef, ref, type Ref } from "vue"
import { IS_PLACEHOLDER, MANIFEST, MANIFEST_TOKENS } from "@/contracts/bridge-generation"
import { resolveToolsTarget } from "@/lib/network-targets"
import { logoKeyOf, type SelectableToken, type TokenIdentity } from "@/lib/send-model"

/** `none` = nothing has been loaded yet, or this network has no bridge to load a list for. */
export type CatalogProvenance = TokenListProvenance | "none"

export interface UseTokenCatalogHandle {
	readonly tokens: Readonly<Ref<SelectableToken[]>>
	readonly provenance: Ref<CatalogProvenance>
	readonly loading: Ref<boolean>
	readonly error: Ref<string | null>
	readonly search: Ref<string>
	readonly filtered: ComputedRef<SelectableToken[]>
	/** The chain every row lives on — the manifest's, whatever the wallet is connected to. */
	readonly chainId: number
	/** Adds a token by address; the identity is the lookup's read of the contract, when there was one. */
	addPasted: (address: string, identity?: TokenIdentity) => SelectableToken
	refresh: () => Promise<void>
	dispose: () => void
}

const HEX20 = /^0x[0-9a-fA-F]{40}$/
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"

const memoryBacking = new Map<string, string>()
const memoryKv: KV = {
	getItem: (k) => memoryBacking.get(k) ?? null,
	setItem: (k, v) => void memoryBacking.set(k, v),
	removeItem: (k) => void memoryBacking.delete(k),
}

/** Reading `localStorage` THROWS (not returns undefined) on an origin with storage disabled, so the
 *  probe is guarded; without it the catalog simply stops surviving a reload. */
function catalogKv(): KV {
	try {
		if (typeof localStorage !== "undefined") return localStorage
	} catch {
		return memoryKv
	}
	return memoryKv
}

/** The generation's own tokens, in manifest order — the curated head of every catalog. */
function manifestCatalog(): SelectableToken[] {
	return MANIFEST_TOKENS.map((t) => {
		const address = t.erc20.toLowerCase() as Address
		return {
			chainId: MANIFEST.l1ChainId,
			address,
			symbol: t.displaySymbol,
			name: t.displayName,
			decimals: t.decimals,
			source: "manifest" as const,
			logoKey: logoKeyOf(MANIFEST.l1ChainId, address),
		}
	})
}

function fromCatalog(t: CatalogToken): SelectableToken {
	return {
		chainId: t.chainId,
		address: t.address,
		symbol: t.symbol,
		name: t.name,
		decimals: t.decimals,
		source: "list",
		logoKey: logoKeyOf(t.chainId, t.address),
	}
}

type CatalogLoad = { ok: true; tokens: SelectableToken[]; provenance: TokenListProvenance } | { ok: false; message: string }

/** The loader itself degrades rather than rejecting; a KV whose reads throw still can, so the whole
 *  load is folded into one outcome and the caller never has to unwind. */
async function loadCatalog(chainId: number): Promise<CatalogLoad> {
	try {
		const fixtures = resolveToolsTarget().tokenListSha256
		const loaded = await loadTokenList({
			chainId,
			// Unbound, a native `fetch` throws on invocation — the loader calls exactly what it is given.
			fetch: globalThis.fetch.bind(globalThis),
			kv: catalogKv(),
			...(fixtures ? { list: { url: TOKEN_LIST_URL, sha256: fixtures } } : {}),
		})
		return { ok: true, tokens: loaded.tokens.map(fromCatalog), provenance: loaded.provenance }
	} catch (e) {
		return { ok: false, message: e instanceof Error ? e.message : "Could not load the token list." }
	}
}

/**
 * Manifest first, then what the user pasted, then the list; one entry per address. A pasted address
 * the list also carries keeps the position the user pasted it at but takes the list's metadata —
 * the pasted entry has none until it is selected.
 */
function merge(
	manifest: readonly SelectableToken[],
	pasted: readonly SelectableToken[],
	listed: readonly SelectableToken[],
): SelectableToken[] {
	const byAddress = new Map(listed.map((t) => [t.address, t]))
	const out: SelectableToken[] = []
	const seen = new Set<string>()
	for (const t of [...manifest, ...pasted]) {
		if (seen.has(t.address)) continue
		seen.add(t.address)
		out.push(t.source === "pasted" ? (byAddress.get(t.address) ?? t) : t)
	}
	for (const t of listed) {
		if (seen.has(t.address)) continue
		seen.add(t.address)
		out.push(t)
	}
	return out
}

/** The caller owns the lifecycle: call `refresh()` when the step mounts and `dispose()` when it unmounts. */
export function useTokenCatalog(): UseTokenCatalogHandle {
	const listed = ref<SelectableToken[]>([])
	const pasted = ref<SelectableToken[]>([])
	const provenance = ref<CatalogProvenance>("none")
	const loading = ref(false)
	const error = ref<string | null>(null)
	const search = ref("")
	const manifest = manifestCatalog()
	let disposed = false
	let generation = 0

	const tokens = computed<SelectableToken[]>(() => merge(manifest, pasted.value, listed.value))

	const filtered = computed<SelectableToken[]>(() => {
		const q = search.value.trim().toLowerCase()
		if (q === "") return tokens.value
		return tokens.value.filter(
			(t) => t.symbol.toLowerCase().startsWith(q) || t.name.toLowerCase().startsWith(q) || t.address.startsWith(q),
		)
	})

	const stale = (mine: number): boolean => disposed || mine !== generation

	async function refresh(): Promise<void> {
		// A network with no bridge has nothing to send to: never spend a fetch on it.
		if (IS_PLACEHOLDER || disposed) return
		const mine = ++generation
		loading.value = true
		error.value = null
		const result = await loadCatalog(MANIFEST.l1ChainId)
		if (stale(mine)) return
		if (result.ok) {
			listed.value = result.tokens
			provenance.value = result.provenance
		} else {
			error.value = result.message
		}
		loading.value = false
	}

	function addPasted(address: string, identity?: TokenIdentity): SelectableToken {
		const trimmed = address.trim()
		if (!HEX20.test(trimmed)) throw new Error("Enter a token address: 0x followed by 40 hex characters.")
		const lower = trimmed.toLowerCase() as Address
		if (lower === ZERO_ADDRESS) throw new Error("The zero address is not a token.")
		if (tokens.value.some((t) => t.address === lower)) throw new Error("That token is already in the list.")
		// The identity is what the lookup read from the contract; without one the SELECTION step fills
		// it from the chain, and `decimals: -1` is the sentinel for "not read yet" that must never reach
		// an amount formatter.
		const token: SelectableToken = {
			chainId: MANIFEST.l1ChainId,
			address: lower,
			symbol: identity?.symbol ?? "",
			name: identity?.name ?? "",
			decimals: identity?.decimals ?? -1,
			source: "pasted",
			logoKey: logoKeyOf(MANIFEST.l1ChainId, lower),
		}
		pasted.value = [...pasted.value, token]
		return token
	}

	function dispose(): void {
		disposed = true
		generation++
		loading.value = false
	}

	return { chainId: MANIFEST.l1ChainId, tokens, provenance, loading, error, search, filtered, addPasted, refresh, dispose }
}
