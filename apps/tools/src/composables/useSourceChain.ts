/**
 * The chains a deposit can start on besides Ethereum, as the token step offers them: the registry's source tokens as
 * rows, the owner's token and native balances on each chain, and the chains where the owner is a contract and so may
 * not send. Reads go through the build's pinned RPCs, never the wallet, so they hold whichever chain the wallet is on.
 */
import { type Address, erc20Abi, type Hex } from "viem"
import { type ComputedRef, computed, type Ref, shallowRef, watch } from "vue"
import { MANIFEST } from "@/contracts/bridge-generation"
import { chainLabel } from "@/lib/chains"
import { type AppSource, NETWORK, sourcesOf } from "@/lib/network"
import { logoKeyOf, type SelectableToken } from "@/lib/send-model"
import { joinWords } from "@/lib/word-list"
import { readClientFor } from "./useEthereumReader"

let registry: readonly AppSource[] | undefined

/** The registry's sources for this build, read once; empty, and logged, where the manifest and the build disagree. */
export function appSources(): readonly AppSource[] {
	if (registry) return registry
	try {
		registry = sourcesOf(MANIFEST)
	} catch (e) {
		console.error(e instanceof Error ? e : new Error("the source registry could not be read"))
		registry = []
	}
	return registry
}

/** Test-only: read the registry again on the next call. */
export function __resetSourcesForTests(): void {
	registry = undefined
}

/** The source chains in manifest order, each once. */
export function sourceChainIds(sources: readonly AppSource[]): number[] {
	return [...new Set(sources.map((s) => s.chainId))]
}

/** "Base Sepolia or Ethereum · Sepolia": every chain a deposit can start on; "" when the registry offers no source. */
export function fromChainsLine(sources: readonly AppSource[]): string {
	const ids = sourceChainIds(sources)
	return ids.length === 0 ? "" : joinWords([...ids, NETWORK.l1ChainId].map(chainLabel), "or")
}

/** The registry's tokens as token-step rows, in manifest order. */
export function sourceRowsOf(sources: readonly AppSource[]): SelectableToken[] {
	return sources.flatMap((s) =>
		s.tokens.map((t) => {
			const address = t.address.toLowerCase() as Address
			return {
				chainId: s.chainId,
				address,
				symbol: t.symbol,
				name: t.symbol,
				decimals: t.decimals,
				source: "manifest" as const,
				logoKey: logoKeyOf(s.chainId, address),
			}
		}),
	)
}

/** The registry entry behind a source row: its rail, and the Ethereum token it delivers. */
export function sourceTokenOf(
	row: Pick<SelectableToken, "chainId" | "address">,
	sources: readonly AppSource[] = appSources(),
): { source: AppSource; token: AppSource["tokens"][number] } | undefined {
	const source = sources.find((s) => s.chainId === row.chainId)
	const token = source?.tokens.find((t) => t.address.toLowerCase() === row.address.toLowerCase())
	return source && token ? { source, token } : undefined
}

/** Where a chain's native balance sits in `balances`; token rows sit under their `logoKey`. */
export const nativeKeyOf = (chainId: number): string => `native:${chainId}`

/** An EIP-7702 account's code is only this designator, and it still signs as an EOA. */
const DELEGATION = /^0xef0100[0-9a-f]{40}$/i

/** Contract code that is neither empty nor an EIP-7702 delegation. */
export function isContractCode(code: Hex | undefined): boolean {
	return code !== undefined && code !== "0x" && !DELEGATION.test(code)
}

export interface SourceReader {
	nativeBalance(owner: Address): Promise<bigint>
	tokenBalance(token: Address, owner: Address): Promise<bigint>
	code(owner: Address): Promise<Hex | undefined>
}

function pinnedReader(chainId: number): SourceReader | undefined {
	const client = readClientFor(chainId)
	if (!client) return undefined
	return {
		nativeBalance: (owner) => client.getBalance({ address: owner }),
		tokenBalance: (token, owner) => client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [owner] }),
		code: (owner) => client.getCode({ address: owner }),
	}
}

export interface SourceChainDeps {
	owner: () => Address | undefined
	walletChainId: () => number | null
	switchChain: (chainId: number) => Promise<boolean>
	/** Defaults to the build's pinned read clients; a chain without one reads nothing. */
	reader?: (chainId: number) => SourceReader | undefined
	/** Defaults to the bundled manifest's registry. */
	sources?: () => readonly AppSource[]
}

export interface UseSourceChainHandle {
	readonly sources: readonly AppSource[]
	readonly rows: readonly SelectableToken[]
	/** Token balances under `logoKey`, native ones under `nativeKeyOf`; a chain that could not be read has none. */
	readonly balances: Ref<Record<string, bigint>>
	/** Source chains where the owner holds contract code. A chain whose code could not be read is not listed. */
	readonly contractChains: Ref<readonly number[]>
	readonly walletChainId: ComputedRef<number | null>
	/** Whether the owner is a contract on `chainId`, read once per chain and owner. Rejects where it cannot be read. */
	contractAccount: (chainId: number) => Promise<boolean>
	switchTo: (chainId: number) => Promise<boolean>
	/** Re-reads every chain; what was read stands until the new reads land. */
	refresh: () => Promise<void>
	dispose: () => void
}

export function useSourceChain(deps: SourceChainDeps): UseSourceChainHandle {
	const sources = (deps.sources ?? appSources)()
	const reader = deps.reader ?? pinnedReader
	const rows = sourceRowsOf(sources)
	const chains = sourceChainIds(sources)
	const balances = shallowRef<Record<string, bigint>>({})
	const contractChains = shallowRef<readonly number[]>([])
	const codes = new Map<string, boolean>()
	let epoch = 0
	let disposed = false

	async function contractAccount(chainId: number): Promise<boolean> {
		const owner = deps.owner()
		if (!owner) return false
		const key = `${chainId}:${owner.toLowerCase()}`
		const known = codes.get(key)
		if (known !== undefined) return known
		const read = reader(chainId)
		if (!read) throw new Error(`No pinned RPC reads chain ${chainId}.`)
		const isContract = isContractCode(await read.code(owner))
		codes.set(key, isContract)
		return isContract
	}

	async function readChain(chainId: number, owner: Address): Promise<Record<string, bigint>> {
		const read = reader(chainId)
		if (!read) return {}
		const tokens = rows.filter((r) => r.chainId === chainId)
		const [native, ...held] = await Promise.all([read.nativeBalance(owner), ...tokens.map((t) => read.tokenBalance(t.address, owner))])
		const out: Record<string, bigint> = { [nativeKeyOf(chainId)]: native }
		tokens.forEach((t, i) => {
			out[t.logoKey] = held[i] ?? 0n
		})
		return out
	}

	async function refresh(): Promise<void> {
		const mine = ++epoch
		const owner = deps.owner()
		if (!owner || chains.length === 0) return
		const [read, refused] = await Promise.all([
			Promise.allSettled([...chains, NETWORK.l1ChainId].map((id) => readChain(id, owner))),
			Promise.allSettled(chains.map(async (id) => ((await contractAccount(id)) ? id : null))),
		])
		if (disposed || mine !== epoch) return
		for (const r of [...read, ...refused]) if (r.status === "rejected") console.debug(r.reason)
		balances.value = Object.fromEntries(read.flatMap((r) => (r.status === "fulfilled" ? Object.entries(r.value) : [])))
		contractChains.value = refused.flatMap((r) => (r.status === "fulfilled" && r.value !== null ? [r.value] : []))
	}

	// A new owner never shows the last one's figures, even for the moment its own reads take.
	const stop = watch(
		() => deps.owner()?.toLowerCase(),
		() => {
			balances.value = {}
			contractChains.value = []
			void refresh()
		},
		{ immediate: true },
	)

	return {
		sources,
		rows,
		balances,
		contractChains,
		walletChainId: computed(() => deps.walletChainId()),
		contractAccount,
		switchTo: (chainId) => deps.switchChain(chainId),
		refresh,
		dispose: () => {
			disposed = true
			stop()
		},
	}
}
