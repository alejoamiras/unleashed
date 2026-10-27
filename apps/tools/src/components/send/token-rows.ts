import { chainLabel } from "@/lib/chains"
import { L1_CHAIN_LABEL } from "@/lib/network"
import type { SelectableToken } from "@/lib/send-model"

/** How a token-step row reads beyond its token: what its second line says, and whether it can be picked. */
export interface RowLook {
	/** Leads the second line; the row's trimmed address follows it unless `withAddress` is false. */
	sub?: string
	/** Defaults to true: a row whose name or symbol can be copied keeps its address in view. */
	withAddress?: boolean
	/** Shown for what it holds, never picked: the click and Enter do nothing. */
	disabled?: boolean
	/** A chain's native coin, which has no contract address to show. */
	native?: boolean
}

/** "all", or the one chain whose rows are shown. */
export type NetworkFilter = "all" | number

export interface StepRowsInput {
	/** The Ethereum catalog, already narrowed by the search. */
	catalog: readonly SelectableToken[]
	/** The registry's source tokens, in manifest order. */
	sources: readonly SelectableToken[]
	natives: readonly SelectableToken[]
	/** Source chains the owner may not send from. */
	refused: readonly number[]
	network: NetworkFilter
	search: string
}

export interface StepRows {
	rows: SelectableToken[]
	looks: Record<string, RowLook>
}

/** The search reaches a source or native row by its symbol or its chain's name; the catalog does its own. */
function matches(t: SelectableToken, query: string): boolean {
	return query === "" || t.symbol.toLowerCase().includes(query) || chainLabel(t.chainId).toLowerCase().includes(query)
}

/** The deposit token step's rows, in order: sources that can send, the Ethereum catalog, sources that cannot, native coins. */
export function depositRows(i: StepRowsInput): StepRows {
	const refused = new Set(i.refused)
	const query = i.search.trim().toLowerCase()
	const shown = (t: SelectableToken) => i.network === "all" || t.chainId === i.network
	const sources = i.sources.filter((t) => shown(t) && matches(t, query))
	const open = sources.filter((t) => !refused.has(t.chainId))
	const shut = sources.filter((t) => refused.has(t.chainId))
	const catalog = i.catalog.filter(shown)
	const natives = i.natives.filter((t) => shown(t) && matches(t, query))

	const looks: Record<string, RowLook> = {}
	for (const t of sources) looks[t.logoKey] = { sub: chainLabel(t.chainId), withAddress: false, disabled: refused.has(t.chainId) }
	for (const t of catalog) {
		looks[t.logoKey] =
			t.source === "manifest" ? { sub: `${L1_CHAIN_LABEL} · no bridge step`, withAddress: false } : { sub: L1_CHAIN_LABEL }
	}
	for (const t of natives) {
		looks[t.logoKey] = { sub: `pays your ${chainLabel(t.chainId)} fees`, withAddress: false, disabled: true, native: true }
	}
	return { rows: [...open, ...catalog, ...shut, ...natives], looks }
}
