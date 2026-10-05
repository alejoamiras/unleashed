/**
 * Turns a catalog entry into the token the review step acts on: the factory's frozen registration
 * (or a preview of it), the hub's binding (or the address it will derive), and the balances the
 * chosen direction needs.
 *
 * Every resolve runs under an EPOCH. A user who taps three tokens in a row gets three overlapping
 * reads, and only the last one may land — a superseded result must never overwrite the selection or
 * its balances, however late it arrives.
 */
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import type { ContractBase } from "@aztec-labs/aztec.js/contracts"
import {
	type Erc20Metadata,
	predictPortal,
	readErc20Balances,
	readErc20Metadata,
	readRegistration,
	type Registration,
	toWord,
	tokenStateOf,
} from "@unleashed/bridge-core"
import type { Address, Hex, PublicClient } from "viem"
import { type Ref, ref, shallowRef } from "vue"
import { rebuildHubTokenInstance, SEND_GENERATION } from "@/contracts/bridge-generation"
import { assertL1Chain } from "./useSend"
import type { Direction, MetadataConflict, ResolvedToken, SelectableToken, TokenBalances, TokenWords } from "@/lib/send-model"
import { userMessage } from "@/lib/errors"
import { safeDisplay } from "@/lib/token-display"

export interface TokenSelectionDeps {
	pub: () => PublicClient | undefined
	l1Account: () => Address | undefined
	/** The hub's L2 token for an ERC-20, read from the node — no Aztec wallet needed; undefined when unregistered. */
	readBinding: (erc20: Address) => Promise<string | undefined>
	l2Account: () => string | undefined
	/** The L2 Token contract bound to the connected wallet — async because `Contract.at` is. */
	tokenContract?: (l2Token: string) => Promise<ContractBase | undefined> | ContractBase | undefined
}

export interface UseTokenSelectionHandle {
	readonly selected: Ref<ResolvedToken | null>
	readonly balances: Ref<TokenBalances>
	readonly loading: Ref<boolean>
	readonly error: Ref<string | null>
	epoch: () => number
	select: (token: SelectableToken, direction: Direction) => Promise<void>
	refreshBalances: () => Promise<void>
	dispose: () => void
}

const ZERO_FIELD = `0x${"0".repeat(64)}` as Hex

interface ChainReads {
	registration: Registration | undefined
	meta: Erc20Metadata | undefined
	/** The hub's L2 token for this ERC-20; undefined both when unregistered and when no hub is connected. */
	bound: string | undefined
}

/**
 * The token contract's own strings. REQUIRED where the wizard has none it can trust — a pasted
 * address carries no symbol or decimals, an unregistered token has no attested words to preview
 * from — and read best-effort for a list entry, whose curated strings are a claim this resolve
 * exists to check. Best-effort there because a token with no `name()` must still be selectable.
 */
async function readMetadata(
	pub: PublicClient,
	token: SelectableToken,
	registration: Registration | undefined,
): Promise<Erc20Metadata | undefined> {
	if (token.source === "pasted" || registration === undefined) return readErc20Metadata(pub, token.address)
	if (token.source !== "list") return undefined
	return readErc20Metadata(pub, token.address).catch(() => undefined)
}

/**
 * The list's strings are a claim by whoever publishes the list; the token contract's own are the
 * fact. Where they disagree the resolve keeps the LIVE values and carries the disagreement to the
 * review, rather than letting a poisoned list label an arbitrary address "USDC" unchallenged.
 */
function metadataConflictOf(token: SelectableToken, meta: Erc20Metadata | undefined): MetadataConflict | undefined {
	if (token.source !== "list" || !meta) return undefined
	const listed = { symbol: token.symbol, name: token.name, decimals: token.decimals }
	const live = { symbol: meta.symbol, name: meta.name, decimals: meta.decimals }
	if (listed.symbol === live.symbol && listed.name === live.name && listed.decimals === live.decimals) return undefined
	return { listed, live }
}

function wordsOf(registration: Registration | undefined, meta: Erc20Metadata | undefined): TokenWords {
	if (registration) return { nameWord: registration.nameWord, symbolWord: registration.symbolWord }
	if (!meta) throw new Error("cannot preview a token's words without its live metadata")
	// The RAW returndata is the sanitizer's only valid input: an invalid byte decodes to a 3-byte
	// U+FFFD, so words previewed from the decoded strings derive an address the hub never mints to.
	return { nameWord: toWord(meta.nameRaw), symbolWord: toWord(meta.symbolRaw) }
}

async function toResolved(token: SelectableToken, reads: ChainReads): Promise<ResolvedToken> {
	const gen = SEND_GENERATION
	if (!gen) throw new Error("This network has no bridge.")
	const { registration, meta, bound } = reads
	const words = wordsOf(registration, meta)
	// Chain before list, always: the factory's frozen decimals, else the contract's own; a list's
	// are the last resort, and getting them wrong misprices the send.
	const decimals = registration?.decimals ?? meta?.decimals ?? token.decimals
	// Only the manifest's own tokens keep their curated strings; everything else shows what the
	// contract answers — stripped and capped once here, so no surface downstream renders a bidi
	// override or a kilobyte of "symbol" — so a list cannot dress an arbitrary address up as a token
	// the user knows. The RAW bytes stay in `words` for the derivation.
	const display =
		token.source !== "manifest" && meta
			? { symbol: safeDisplay(meta.symbol), name: safeDisplay(meta.name) }
			: { symbol: token.symbol, name: token.name }
	const conflict = metadataConflictOf(token, meta)
	return {
		...token,
		...display,
		decimals,
		...(conflict ? { metadataConflict: conflict } : {}),
		state: tokenStateOf(registration, bound === undefined ? ZERO_FIELD : (bound as Hex)),
		portal: (registration?.portal ?? predictPortal(gen.factory, gen.implementation, token.address)) as Address,
		words,
		// Registered: the hub's own binding. Otherwise the address the hub WILL derive from these
		// words — a preview for the review screen; the receipt re-reads the frozen registration.
		l2Token: (bound ?? (await rebuildHubTokenInstance(token.address, { ...words, decimals })).address.toString()) as Hex,
		registration,
	}
}

function toBigInt(value: unknown): bigint {
	if (typeof value === "bigint") return value
	if (typeof value === "number" || typeof value === "string") return BigInt(value)
	if (value && typeof value === "object" && "toBigInt" in value) {
		const fn = (value as { toBigInt: () => bigint }).toBigInt
		if (typeof fn === "function") return fn.call(value)
	}
	return 0n
}

async function simulateBalance(contract: ContractBase, fn: "balance_of_public" | "balance_of_private", account: string): Promise<bigint> {
	const method = contract.methods[fn]
	if (typeof method !== "function") throw new Error(`the L2 token exposes no ${fn}`)
	const from = AztecAddress.fromStringUnsafe(account)
	const raw = (await method(from).simulate({ from } as never)) as { result?: unknown }
	return toBigInt(raw?.result ?? raw)
}

export function useTokenSelection(deps: TokenSelectionDeps): UseTokenSelectionHandle {
	// Shallow: both are replaced wholesale, and deep reactivity would proxy the chain-shaped
	// registration object for nothing.
	const selected = shallowRef<ResolvedToken | null>(null)
	const balances = shallowRef<TokenBalances>({})
	const loading = ref(false)
	const error = ref<string | null>(null)
	let epochValue = 0
	let disposed = false
	let lastDirection: Direction = "l1-to-l2"

	const stale = (mine: number): boolean => disposed || mine !== epochValue

	async function readChain(pub: PublicClient, token: SelectableToken, factory: Address): Promise<ChainReads> {
		const registration = await readRegistration(pub, factory, token.address)
		const meta = await readMetadata(pub, token, registration)
		// The hub only binds a token the factory has registered; without a registration there is
		// nothing to read, and with one the binding says whether the hub's side is done too.
		const bound = registration ? await deps.readBinding(token.address) : undefined
		return { registration, meta, bound }
	}

	async function readL2Balances(token: ResolvedToken): Promise<TokenBalances> {
		const account = deps.l2Account()
		const contract = await deps.tokenContract?.(token.l2Token)
		if (!account || !contract) return {}
		// Settled independently: one unreadable side must not cost the caller the other.
		const [pub, prv] = await Promise.allSettled([
			simulateBalance(contract, "balance_of_public", account),
			simulateBalance(contract, "balance_of_private", account),
		])
		const out: TokenBalances = {}
		if (pub.status === "fulfilled") out.l2Public = pub.value
		if (prv.status === "fulfilled") out.l2Private = prv.value
		return out
	}

	async function loadBalances(pub: PublicClient, token: ResolvedToken, direction: Direction, mine: number): Promise<void> {
		const next: TokenBalances = {}
		const owner = deps.l1Account()
		if (owner) next.l1 = (await readErc20Balances(pub, owner, [token.address])).get(token.address) ?? 0n
		// The L2 side exists only once the hub has registered the token, and only an exit needs it up
		// front — a deposit's L2 balance is whatever its own claim will create.
		if (token.state.kind === "registered" && direction === "l2-to-l1") Object.assign(next, await readL2Balances(token))
		// A refresh shares the epoch of a selection still resolving, so the token and owner it read for
		// are checked too: a late answer for either is another token's or account's balance.
		if (stale(mine) || selected.value !== token || deps.l1Account() !== owner) return
		balances.value = next
	}

	async function resolveInto(token: SelectableToken, direction: Direction, mine: number): Promise<void> {
		const pub = deps.pub()
		if (!pub) throw new Error("Connect your Ethereum wallet to read this token.")
		const gen = SEND_GENERATION
		if (!gen) throw new Error("This network has no bridge.")
		// Metadata read on another chain is another token's (or nobody's): the decimals would size
		// the amount and the words would derive the L2 token. Nothing resolves off-chain.
		await assertL1Chain({ publicClient: pub })
		const resolved = await toResolved(token, await readChain(pub, token, gen.factory))
		// Bracketed like the registration validation: a switch DURING the reads is caught here.
		await assertL1Chain({ publicClient: pub })
		if (stale(mine)) return
		selected.value = resolved
		balances.value = {}
		await loadBalances(pub, resolved, direction, mine)
	}

	async function select(token: SelectableToken, direction: Direction): Promise<void> {
		const mine = ++epochValue
		lastDirection = direction
		loading.value = true
		error.value = null
		try {
			await resolveInto(token, direction, mine)
		} catch (e) {
			if (stale(mine)) return
			selected.value = null
			balances.value = {}
			error.value = userMessage(e, "Could not read this token.")
		}
		if (!stale(mine)) loading.value = false
	}

	async function refreshBalances(): Promise<void> {
		const token = selected.value
		const pub = deps.pub()
		if (!token || !pub || disposed) return
		await loadBalances(pub, token, lastDirection, epochValue)
	}

	function dispose(): void {
		disposed = true
		epochValue++
		loading.value = false
	}

	return { selected, balances, loading, error, epoch: () => epochValue, select, refreshBalances, dispose }
}
