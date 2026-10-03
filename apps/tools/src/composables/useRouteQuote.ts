/**
 * The fuel route for one token: can this deposit buy Fee Juice on the way in, and through which
 * pools. Debounced because it hangs off an amount field, and latest-wins because a stale probe
 * answering after a fresher one would price the wrong route.
 */
import { discoverFuelRoute, type RouteOutcome } from "@unleashed/bridge-core"
import type { Address, PublicClient } from "viem"
import { ref, type Ref, shallowRef } from "vue"
import { FUEL_ASSET, SWAP } from "@/contracts/bridge-generation"

const DEBOUNCE_MS = 400

/** An outcome carries the question it answers. The caller compares before it prices anything: a
 *  token switch that lands inside the debounce would otherwise leave the previous token's route
 *  readable, and a review reached in that window would be priced on a swap path for another token. */
export interface QuotedRoute {
	readonly token: Address
	readonly probeAmount: bigint
	readonly outcome: RouteOutcome
}

export interface UseRouteQuoteHandle {
	readonly quoted: Ref<QuotedRoute | null>
	readonly loading: Ref<boolean>
	readonly error: Ref<string | null>
	quote: (token: Address, probeAmount: bigint) => Promise<void>
	dispose: () => void
}

type SwapConfig = NonNullable<typeof SWAP>

/** Discovery answers `unavailable` for a dead transport by itself; a throw out of it is a malformed
 *  route, which is a config fault and never a retry. Both come back as one settled outcome. */
async function discover(
	pub: PublicClient,
	swap: SwapConfig,
	token: Address,
	probeAmount: bigint,
): Promise<{ outcome: RouteOutcome; message: string | null }> {
	try {
		const outcome = await discoverFuelRoute({
			client: pub,
			quoter: swap.quoter as Address,
			multicall3: swap.multicall3 as Address,
			token,
			feeAsset: FUEL_ASSET,
			weth: swap.weth as Address,
			feeJuice: swap.feeJuice as Address,
			tiers: swap.tiers,
			ethFj: swap.ethFj,
			probeAmount,
		})
		return { outcome, message: null }
	} catch (e) {
		return {
			outcome: { kind: "unavailable", reason: "config" },
			message: e instanceof Error ? e.message : "This token has no usable gas route.",
		}
	}
}

export function useRouteQuote(deps: { pub: () => PublicClient | undefined }): UseRouteQuoteHandle {
	const quoted = shallowRef<QuotedRoute | null>(null)
	const loading = ref(false)
	const error = ref<string | null>(null)
	let timer: ReturnType<typeof setTimeout> | null = null
	let pending: { seq: number; resolve: () => void } | null = null
	let seq = 0
	let disposed = false

	const stale = (mine: number): boolean => disposed || mine !== seq

	/** A probe resolves its OWN caller; a superseded run must not resolve the one that replaced it. */
	function settle(mine: number): void {
		if (pending?.seq !== mine) return
		pending.resolve()
		pending = null
	}

	/** Resolves whoever is waiting because a newer call (or `dispose`) just replaced their probe. */
	function settleAll(): void {
		pending?.resolve()
		pending = null
	}

	/** Publish an outcome under the question it answers; a superseded probe publishes nothing. */
	function land(token: Address, probeAmount: bigint, outcome: RouteOutcome, message: string | null, mine: number): void {
		if (stale(mine)) return
		quoted.value = { token, probeAmount, outcome }
		error.value = message
		loading.value = false
	}

	async function run(token: Address, probeAmount: bigint, mine: number): Promise<void> {
		const swap = SWAP
		if (!swap) {
			const why = "This network has no swap venue, so a deposit cannot buy gas."
			return land(token, probeAmount, { kind: "unavailable", reason: "config" }, why, mine)
		}
		const pub = deps.pub()
		if (!pub) {
			const why = "Connect your Ethereum wallet to price the gas route."
			return land(token, probeAmount, { kind: "unavailable", reason: "rpc" }, why, mine)
		}
		const found = await discover(pub, swap, token, probeAmount)
		land(token, probeAmount, found.outcome, found.message, mine)
	}

	function quote(token: Address, probeAmount: bigint): Promise<void> {
		if (disposed) return Promise.resolve()
		if (timer !== null) clearTimeout(timer)
		settleAll()
		// SYNCHRONOUS: the previous answer stops being readable the instant a new one is asked for.
		// Clearing it only when the probe lands leaves the whole debounce window quoting the old token.
		quoted.value = null
		error.value = null
		loading.value = true
		const mine = ++seq
		return new Promise<void>((resolve) => {
			pending = { seq: mine, resolve }
			timer = setTimeout(() => {
				timer = null
				void run(token, probeAmount, mine).finally(() => settle(mine))
			}, DEBOUNCE_MS)
		})
	}

	function dispose(): void {
		disposed = true
		seq++
		if (timer !== null) clearTimeout(timer)
		timer = null
		loading.value = false
		settleAll()
	}

	return { quoted, loading, error, quote, dispose }
}
