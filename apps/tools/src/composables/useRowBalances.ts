/**
 * The Ethereum balance behind every row of the token list, read for the connected account and
 * keyed by `logoKey`. Rows are read as they come into view and remembered, so a search that shows
 * new rows costs one batch for those rows only; a read that fails leaves what was read standing;
 * a read that is superseded never lands.
 */
import { readErc20Balances } from "@unleashed/bridge-core"
import type { Address, PublicClient } from "viem"
import { type Ref, shallowRef, watch } from "vue"
import type { SelectableToken } from "@/lib/send-model"

/** A remote list can run to hundreds of tokens; one batch stays bounded to what a screen shows. */
const MAX_ROWS = 50

export interface RowBalancesDeps {
	pub: () => PublicClient | undefined
	owner: () => Address | undefined
	/** The rows on screen, in order; the head of the list is what gets read. */
	tokens: () => readonly SelectableToken[]
}

export interface UseRowBalancesHandle {
	readonly balances: Ref<Record<string, bigint>>
	/** Re-reads the rows on screen — after a mint or a finished send. */
	refresh: () => Promise<void>
	dispose: () => void
}

export function useRowBalances(deps: RowBalancesDeps): UseRowBalancesHandle {
	const balances = shallowRef<Record<string, bigint>>({})
	let epoch = 0
	let disposed = false
	let readFor: Address | undefined

	async function read(rows: readonly SelectableToken[], mine: number): Promise<void> {
		const pub = deps.pub()
		const owner = deps.owner()
		if (!pub || !owner || rows.length === 0) return
		try {
			const got = await readErc20Balances(
				pub,
				owner,
				rows.map((r) => r.address),
			)
			if (disposed || mine !== epoch) return
			const next = { ...balances.value }
			for (const row of rows) next[row.logoKey] = got.get(row.address) ?? 0n
			balances.value = next
		} catch (e) {
			console.debug(e instanceof Error ? e : new Error("row balances could not be read"))
		}
	}

	function visible(): readonly SelectableToken[] {
		return deps.tokens().slice(0, MAX_ROWS)
	}

	/** The rows on screen the map does not hold yet; everything when the account changed. */
	function fill(): void {
		const mine = ++epoch
		const owner = deps.owner()
		if (owner !== readFor) {
			readFor = owner
			balances.value = {}
		}
		if (!owner) return
		const held = balances.value
		void read(
			visible().filter((r) => !(r.logoKey in held)),
			mine,
		)
	}

	/** Re-reads the rows on screen; what was read before stands until the new batch lands. */
	async function refresh(): Promise<void> {
		await read(visible(), ++epoch)
	}

	// Keyed on the identity of the inputs, not their objects: a list load replaces the array several
	// times while the rows it holds stay the same, and each replacement must not cost a batch read.
	const stop = watch(
		() =>
			`${deps.owner() ?? ""}|${visible()
				.map((t) => t.logoKey)
				.join(",")}`,
		fill,
		{ immediate: true },
	)

	function dispose(): void {
		disposed = true
		epoch++
		stop()
	}

	return { balances, refresh, dispose }
}
