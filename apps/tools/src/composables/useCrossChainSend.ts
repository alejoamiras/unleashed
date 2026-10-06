/**
 * The send wizard's cross-chain branch: the registry entry behind a picked source row, the Ethereum token its rail
 * delivers (resolved like an Ethereum-origin pick, but through the build's pinned Ethereum reader, so it holds
 * whichever chain the wallet is on), the route for the user's ask with its gas slice sized by the same `useGasShare`
 * the Ethereum-origin path uses, what that route means in the source token's units, and the send itself.
 */
import type { TokenState } from "@unleashed/bridge-core"
import type { AppSource } from "@/lib/network"
import { type ComputedRef, computed, type Ref, ref, watch } from "vue"
import type { Address, WalletClient } from "viem"
import { FUEL } from "@/contracts/bridge-generation"
import { readHubBinding } from "@/contracts/hub-binding"
import { type CrossChainFigures, type FeeCeiling, feeCeilingOf, figuresOf } from "@/lib/crosschain-figures"
import { IS_MAINNET, NETWORK } from "@/lib/network"
import {
	GAS_TOO_SMALL,
	type GasLegPlan,
	gasMinimumShortfall,
	logoKeyOf,
	PRIVATE_SLICE_SHORT,
	type ResolvedToken,
	type SelectableToken,
	type SendIntent,
	type SendPlan,
} from "@/lib/send-model"
import { useNow } from "@/lib/clock"
import { sendCrossChain, walletOnChain } from "./crosschain-deposit-flow"
import {
	appRouteDeps,
	type CrossChainAsk,
	type CrossChainGas,
	type CrossChainRoute,
	type QuotedRoute,
	ROUTE_TTL_MS,
	type RouteDeps,
	type SliceSizer,
	useCrossChainRoute,
} from "./useCrossChainRoute"
import { readClientFor } from "./useEthereumReader"
import type { UseGasShareHandle } from "./useGasShare"
import { appSources, sourceTokenOf } from "./useSourceChain"
import { type TokenSelectionDeps, type UseTokenSelectionHandle, useTokenSelection } from "./useTokenSelection"

/** Why the amount step cannot offer the route on screen; each is drawn as a box in place of the figures. */
export type CrossChainNotice =
	/** The rail or the gas venue quotes nothing for this ask. */
	| { kind: "no-route" }
	/** Our own bytes failed the decoder; nothing is offered. */
	| { kind: "refused"; field: string }
	/** The gas venue could not be read: an outage, not a refusal. */
	| { kind: "venue" }
	/** This build cannot route from the chain at all. */
	| { kind: "unavailable" }
	/** A read the quote needs failed; trying again may work. */
	| { kind: "failed"; message: string }

export interface CrossChainSendDeps {
	/** The picked row; null, or a row the registry does not offer, leaves the branch idle. */
	row: () => SelectableToken | null
	/** The amount in the source token's base units; null while the field holds none. */
	amount: () => bigint | null
	intent: () => SendIntent
	isPrivate: () => boolean
	/** The connected Ethereum account: it signs on the source chain and is the refund and fallback address. */
	user: () => Address | undefined
	/** The Aztec account the deposit is claimed by. */
	recipient: () => string | undefined
	/** True while the amount step shows: only there does a changed ask, or an expired answer, quote again. */
	quoting: () => boolean
	gasShare: Pick<UseGasShareHandle, "propose" | "ceilingsFor" | "txTarget">
	sources?: () => readonly AppSource[]
	routeDeps?: (slice: SliceSizer) => RouteDeps
	selection?: (deps: TokenSelectionDeps) => UseTokenSelectionHandle
	now?: Ref<number>
}

export interface UseCrossChainSendHandle {
	/** The registry entry behind the picked row; undefined for an Ethereum row. */
	readonly entry: ComputedRef<ReturnType<typeof sourceTokenOf>>
	/** The Ethereum token the rail delivers, once read. */
	readonly dest: ComputedRef<ResolvedToken | null>
	/** The answer to the ask on screen, and only to it. */
	readonly quoted: ComputedRef<QuotedRoute | null>
	readonly route: ComputedRef<CrossChainRoute | null>
	readonly figures: ComputedRef<CrossChainFigures | null>
	readonly ceiling: ComputedRef<FeeCeiling | null>
	readonly notice: ComputedRef<CrossChainNotice | null>
	/** Why the route's gas leg cannot be signed, the same refusals the Ethereum-origin slice gets. */
	readonly gasError: ComputedRef<string | null>
	/** The gas leg as the amount step and the plan carry it. */
	readonly gas: ComputedRef<GasLegPlan | null>
	readonly loading: ComputedRef<boolean>
	/** Milliseconds the answer stays signable; null with no answer. */
	readonly expiresIn: ComputedRef<number | null>
	/** The route is offered and may go to the review. */
	readonly ready: ComputedRef<boolean>
	/** The deposit as the journal files it: the route's delivery to the router, net of nothing yet. */
	planOf: (route: CrossChainRoute, ask: CrossChainAsk) => SendPlan | null
	requote: () => void
	send: (quoted: QuotedRoute, route: CrossChainRoute, token: ResolvedToken, client: WalletClient) => Promise<string>
	dispose: () => void
}

const keyOf = (a: CrossChainAsk): string =>
	[a.srcChainId, a.rail, a.srcToken.address, a.srcAmount, a.user, a.intent, a.isPrivate, a.recipient].join("|")

/** The Ethereum token a source token is routed into, as the token step would list it. */
function destRowOf(token: AppSource["tokens"][number]): SelectableToken {
	const address = token.destToken.toLowerCase() as Address
	return {
		chainId: NETWORK.l1ChainId,
		address,
		symbol: token.symbol,
		name: token.symbol,
		decimals: token.decimals,
		source: "manifest",
		logoKey: logoKeyOf(NETWORK.l1ChainId, address),
	}
}

function noticeOf(quoted: QuotedRoute | null, error: string | null, destError: string | null): CrossChainNotice | null {
	const failure = destError ?? error
	if (failure) return { kind: "failed", message: failure }
	const o = quoted?.outcome
	if (!o || o.kind === "route") return null
	if (o.kind === "refused") return { kind: "refused", field: o.field }
	if (o.kind === "no-route") return { kind: "no-route" }
	// A private slice still waiting on Aztec's fees is loading, not unroutable.
	if (o.reason === "pricing") return null
	return o.reason === "The gas venue could not be read." ? { kind: "venue" } : { kind: "unavailable" }
}

type GasShare = CrossChainSendDeps["gasShare"]
type Sized = { fuelAmount: bigint; capped: GasLegPlan["capped"] }

/** The slice a delivery carries, sized by the gas share for the delivered token; `onSized` keeps whether it capped. */
function sizerFor(state: () => TokenState | undefined, gasShare: GasShare, onSized: (s: Sized) => void): SliceSizer {
	return (ask, delivered, rate) => {
		const s = state()
		if (!s) return null
		try {
			const share = gasShare.propose({ amount: delivered, decimals: ask.srcToken.decimals, state: s, rate, isPrivate: ask.isPrivate })
			if (share === "pricing" || share === null) return share
			onSized({ fuelAmount: share.fuelAmount, capped: share.capped })
			return share.fuelAmount
		} catch {
			return null
		}
	}
}

/** The user's ask in the route's terms; null until every input and the delivered token are known. */
function askOf(deps: CrossChainSendDeps, e: SourceEntry, dest: ResolvedToken | null): CrossChainAsk | null {
	const units = deps.amount()
	const user = deps.user()
	const recipient = deps.recipient()
	if (!e || !dest || units === null || units <= 0n || !user || !recipient) return null
	const { address, decimals, destToken } = e.token
	return {
		srcChainId: e.source.chainId,
		rail: e.source.rail,
		srcToken: { address: address as Address, decimals, destToken: destToken as Address },
		srcAmount: units,
		user,
		intent: deps.intent(),
		isPrivate: deps.isPrivate(),
		recipient,
	}
}

/** The same refusals the Ethereum-origin slice gets: no room for a token, under the claim minimum, or a private
 *  floor under the ceilings the claim sets aside. */
function gasErrorOf(r: CrossChainRoute | null, a: CrossChainAsk | undefined, state: TokenState | undefined, gasShare: GasShare) {
	const g = r?.gas
	if (!r || !g || !a || !state) return null
	if (a.intent === "token+gas" && g.fuelAmount >= r.minReceived) return GAS_TOO_SMALL
	const short = FUEL ? gasMinimumShortfall(g.expectedOut, BigInt(FUEL.minFuelFj)) : null
	if (short || a.intent === "gas" || !a.isPrivate) return short
	const ceilings = gasShare.ceilingsFor(state)
	return ceilings !== null && g.minFuelOutput < ceilings ? PRIVATE_SLICE_SHORT : null
}

async function sendOn(
	sources: readonly AppSource[],
	q: QuotedRoute,
	r: CrossChainRoute,
	token: ResolvedToken,
	client: WalletClient,
): Promise<string> {
	const source = sources.find((s) => s.chainId === q.ask.srcChainId)
	const sourceReads = readClientFor(q.ask.srcChainId)
	const ethereum = readClientFor(NETWORK.l1ChainId)
	if (!source || !sourceReads || !ethereum) throw new Error("This build cannot read that network, so nothing was sent.")
	const wallet = walletOnChain(client, q.ask.user, source.chain)
	return sendCrossChain({ ask: q.ask, route: r, token, quotedAt: q.at }, wallet, { source: sourceReads, ethereum })
}

type SourceEntry = ReturnType<typeof sourceTokenOf>

/** The delivered token, read through the pinned Ethereum reader under its own selection. */
function useDestToken(deps: CrossChainSendDeps, entry: ComputedRef<SourceEntry>) {
	const selection = (deps.selection ?? useTokenSelection)({
		pub: () => readClientFor(NETWORK.l1ChainId),
		l1Account: () => undefined,
		readBinding: readHubBinding,
		l2Account: () => undefined,
	})
	const dest = computed(() => {
		const want = entry.value?.token.destToken.toLowerCase()
		const got = selection.selected.value
		return want && got && got.address === want ? got : null
	})
	function resolve(): void {
		const token = entry.value?.token
		if (token && dest.value === null) void selection.select(destRowOf(token), "l1-to-l2")
	}
	const stop = watch(() => entry.value?.token.destToken, resolve, { immediate: true })
	function dispose(): void {
		stop()
		selection.dispose()
	}
	return { selection, dest, resolve, dispose }
}

export function useCrossChainSend(deps: CrossChainSendDeps): UseCrossChainSendHandle {
	const sources = deps.sources ?? appSources
	const now = deps.now ?? useNow()
	const entry = computed(() => {
		const row = deps.row()
		return row ? sourceTokenOf(row, sources()) : undefined
	})
	const destToken = useDestToken(deps, entry)
	const { dest } = destToken
	/** What the sizer last answered: the route keeps the slice, not whether the share capped it. */
	let sized: Sized | null = null
	const core = useCrossChainRoute(
		(deps.routeDeps ?? appRouteDeps)(
			sizerFor(
				() => dest.value?.state,
				deps.gasShare,
				(s) => (sized = s),
			),
		),
	)

	const ask = computed(() => askOf(deps, entry.value, dest.value))
	/** A private slice is sized from Aztec's fees: once they land, the ask is quoted again. */
	const priced = computed(() => {
		const a = ask.value
		const state = dest.value?.state
		return !a || !state || a.intent !== "token+gas" || !a.isPrivate || deps.gasShare.ceilingsFor(state) !== null
	})
	const key = computed(() => (ask.value ? `${keyOf(ask.value)}|${deps.gasShare.txTarget.value}|${priced.value}` : null))
	const asked = ref<string | null>(null)

	/** Quotes the ask on screen afresh; with the delivered token still unread, reads it first. */
	function requote(): void {
		destToken.resolve()
		const a = ask.value
		if (!a || !key.value) return
		asked.value = key.value
		void core.quote(a)
	}
	const stopAsk = watch(
		[key, () => deps.quoting()],
		([k, on]) => {
			if (on && k && k !== asked.value) requote()
		},
		{ immediate: true },
	)

	const quoted = computed(() => (asked.value !== null && asked.value === key.value ? core.quoted.value : null))
	const route = computed(() => (quoted.value?.outcome.kind === "route" ? quoted.value.outcome.route : null))
	const expiresIn = computed(() => (quoted.value ? quoted.value.at + ROUTE_TTL_MS - now.value : null))
	// An answer past its TTL is quoted again while the amount step shows it; the review keeps its own and says so.
	const stopExpiry = watch(expiresIn, (left) => {
		if (left !== null && left <= 0 && deps.quoting() && !core.loading.value) requote()
	})

	const figures = computed(() => (route.value && quoted.value ? figuresOf(quoted.value.ask, route.value) : null))
	const ceiling = computed(() => {
		const f = figures.value
		const a = quoted.value?.ask
		return f && a ? feeCeilingOf(f, a.srcToken.decimals, { intent: a.intent, mainnet: IS_MAINNET }) : null
	})
	const notice = computed(() => noticeOf(quoted.value, core.error.value, destToken.selection.error.value))
	const gasError = computed(() => gasErrorOf(route.value, quoted.value?.ask, dest.value?.state, deps.gasShare))

	/** The gas leg in the shape the Ethereum-origin plan carries it: the venue's estimate is the quote. */
	function legOf(g: CrossChainGas): GasLegPlan {
		const capped = sized?.fuelAmount === g.fuelAmount ? sized.capped : null
		return { fuelAmount: g.fuelAmount, fuelFj: 0n, quote: g.expectedOut, minFuelOutput: g.minFuelOutput, venue: g.venue, capped }
	}

	const loading = computed(() => {
		if (!entry.value || notice.value) return false
		return destToken.selection.loading.value || core.loading.value || (ask.value !== null && route.value === null)
	})

	function planOf(r: CrossChainRoute, a: CrossChainAsk): SendPlan | null {
		const token = dest.value
		if (!token) return null
		const plan: SendPlan = { direction: "l1-to-l2", intent: a.intent, token, amount: r.minReceived, isPrivate: a.isPrivate }
		return r.gas ? { ...plan, gas: legOf(r.gas) } : plan
	}

	return {
		entry,
		dest,
		quoted,
		route,
		figures,
		ceiling,
		notice,
		gasError,
		gas: computed(() => (route.value?.gas ? legOf(route.value.gas) : null)),
		loading,
		expiresIn,
		ready: computed(() => route.value !== null && !gasError.value && !ceiling.value?.blocks && !notice.value),
		planOf,
		requote,
		send: (q, r, token, client) => sendOn(sources(), q, r, token, client),
		dispose: () => {
			stopAsk()
			stopExpiry()
			core.dispose()
			destToken.dispose()
		},
	}
}
