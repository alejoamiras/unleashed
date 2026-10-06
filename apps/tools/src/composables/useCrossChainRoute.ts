/**
 * A cross-chain deposit's route, priced and verified before anything is shown: fresh claim secrets, the gas
 * slice quoted at what the rail delivers, Across's terms for our exact message, and the source transaction our
 * own encoder builds from them, accepted by `verifyRoute`. Off mainnet, a deposit Across will not quote is built on
 * `selfBuiltTerms` instead. Questions are debounced, only the latest publishes, and a route is readable for
 * `ROUTE_TTL_MS`: a review older than that quotes again before it signs.
 */
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { computeSecretHash } from "@aztec-labs/aztec.js/crypto"
import { Fr } from "@aztec-labs/aztec.js/fields"
import {
	type AcrossClient,
	type AcrossLimits,
	acrossMessageOf,
	acrossRouteTx,
	acrossSuggestedFees,
	bridgeFromCallerCall,
	crossChainIntent,
	deriveBridgeSecret,
	deriveTokenClaimSecret,
	type FuelProbe,
	type FuelProvider,
	type FuelQuoteProvider,
	type LifiChainBook,
	lifiBook,
	type RailExpectation,
	type RailTerms,
	type RouteExpectation,
	type RouterIntent,
	type RouteTx,
	selfBuiltTerms,
	verifyRoute,
} from "@unleashed/bridge-core"
import type { Address, Hex } from "viem"
import { type ComputedRef, computed, type Ref } from "vue"
import { SEND_GENERATION } from "@/contracts/bridge-generation"
import { IS_MAINNET, NETWORK } from "@/lib/network"
import { resolveToolsTarget } from "@/lib/network-targets"
import { NO_GAS_ROUTE, type SendIntent } from "@/lib/send-model"
import { latestQuote, type Settled } from "./latest-quote"
import { readClientFor } from "./useEthereumReader"
import { fuelProviderOn } from "./useFuelQuote"

const DEBOUNCE_MS = 400
export const ROUTE_TTL_MS = 60_000
/** The draft deposit only sizes the message Across prices; its timing never reaches a signature. */
const DRAFT_WINDOW_S = 7_200

export interface CrossChainAsk {
	srcChainId: number
	rail: "acrossV4" | "stargateV2"
	/** The routing token on the source chain; the rail delivers `destToken`, with the same decimals, on Ethereum. */
	srcToken: { address: Address; decimals: number; destToken: Address }
	srcAmount: bigint
	/** The connected account: it signs on the source chain, and LI.FI hands it a delivery the router refuses. */
	user: Address
	intent: SendIntent
	isPrivate: boolean
	/** The Aztec recipient. */
	recipient: string
}

/** The claim material a route commits to; it lives in memory until the deposit flow journals it. */
export interface CrossChainSecrets {
	/** PUBLIC: the token leg's raw secret. PRIVATE: its claim salt. Absent for a gas-only send. */
	tokenClaimValue?: Fr
	tokenSecretHash?: Hex
	/** Private gas carries the salt the PrivateFPC re-derives its secret from. */
	fuel?: { secret: Fr; secretHash: Hex; bridgeSalt?: Fr }
}

export interface CrossChainGas {
	/** Token units diverted into Fee Juice; all of the delivery for a gas-only send. */
	fuelAmount: bigint
	minFuelOutput: bigint
	/** The venue's estimate: display only. */
	expectedOut: bigint
	venue: FuelProvider
}

export interface CrossChainRoute {
	lifiTxId: Hex
	secrets: CrossChainSecrets
	intent: RouterIntent
	swapData: Hex
	gas?: CrossChainGas
	/** What the router pulls from the Executor; on Across both bounds are what the relayer delivers. */
	minReceived: bigint
	maxPull: bigint
	x: RouteExpectation
	tx: RouteTx
	etaSeconds: number
	fillDeadline: number
	/** Across's own bounds on the amount; null on fixed terms, which nobody quoted. */
	limits: AcrossLimits | null
	/** `fixed`: Across quoted nothing, so the deposit rides `selfBuiltTerms` and waits for a fill by hand. */
	terms: "quoted" | "fixed"
}

export type CrossChainRouteOutcome =
	| { kind: "route"; route: CrossChainRoute }
	/** Nothing to sign for this ask: Across or the gas venue quotes none. */
	| { kind: "no-route"; reason: string }
	/** The decoder refused bytes we built: never offered, never signed. */
	| { kind: "refused"; field: string; reason: string }
	/** This build cannot route the ask: no router, no rail it builds, no Across API, or fees still pricing. */
	| { kind: "unavailable"; reason: string }

/** The gas slice of `delivered`, sized from the venue's rate: null when none can be sized, "pricing" while the
 *  fees a private claim is sized from are loading. */
export type SliceSizer = (ask: CrossChainAsk, delivered: bigint, rate: FuelProbe) => bigint | null | "pricing"

export interface RouteBindings {
	l1ChainId: number
	router: Address
	feeAsset: Address
}

export interface RouteDeps {
	bindings: RouteBindings | undefined
	across: AcrossClient | undefined
	/** The fuel venue for one route, its swap labelled with `lifiTxId`; `reverted` tells a refusal from an outage. */
	fuel: (lifiTxId: Hex) => { provider: FuelQuoteProvider | undefined; reverted: () => boolean }
	slice: SliceSizer
	book?: (chainId: number) => LifiChainBook
	random?: () => Fr
	nowSec?: () => number
	/** The source chain's head time in seconds, which fixed terms are timed from. Absent on mainnet: there, a deposit
	 *  Across will not quote has no route. */
	sourceHeadSec?: (chainId: number) => Promise<number>
}

const hashOf = async (secret: Fr): Promise<Hex> => (await computeSecretHash(secret)).toString() as Hex

/** Fresh secrets bound the way the claims rebuild them: a private token leg derives its secret from
 *  `(claim salt, recipient)`, private gas from `(bridge salt, recipient)`. */
export async function crossChainSecrets(
	intent: SendIntent,
	isPrivate: boolean,
	recipient: string,
	random: () => Fr = Fr.random,
): Promise<CrossChainSecrets> {
	const to = AztecAddress.fromStringUnsafe(recipient)
	const out: CrossChainSecrets = {}
	if (intent !== "gas") {
		const value = random()
		out.tokenClaimValue = value
		out.tokenSecretHash = await hashOf(isPrivate ? deriveTokenClaimSecret(value, to) : value)
	}
	if (intent !== "token") {
		const bridgeSalt = isPrivate ? random() : undefined
		const secret = bridgeSalt ? deriveBridgeSecret(bridgeSalt, to) : random()
		out.fuel = { secret, secretHash: await hashOf(secret), ...(bridgeSalt ? { bridgeSalt } : {}) }
	}
	return out
}

/** The record a route's deposit is journaled under: the token leg's hash, or the gas message's for gas only. */
export const routeRecordId = (s: CrossChainSecrets): Hex => {
	const id = s.tokenSecretHash ?? s.fuel?.secretHash
	if (!id) throw new Error("A route without claim material has no record.")
	return id
}

type Outcome = Settled<CrossChainRouteOutcome>
const settle = (answer: CrossChainRouteOutcome): Outcome => ({ answer, error: null })
const noRoute = (reason: string): Outcome => settle({ kind: "no-route", reason })
const unavailable = (reason: string): Outcome => settle({ kind: "unavailable", reason })

interface RouteCtx {
	ask: CrossChainAsk
	deps: RouteDeps
	b: RouteBindings
	lifiTxId: Hex
	secrets: CrossChainSecrets
	venue?: { provider: FuelQuoteProvider; reverted: () => boolean }
	rate?: FuelProbe
}

/** Why the venue gave no answer: an outage is not a "no route". */
const gasFailure = (c: RouteCtx): Outcome =>
	c.venue && !c.venue.reverted() ? unavailable("The gas venue could not be read.") : noRoute(NO_GAS_ROUTE)

async function sliceOf(c: RouteCtx, venue: FuelQuoteProvider, delivered: bigint): Promise<bigint | Outcome> {
	if (c.ask.intent === "gas") return delivered
	if (!c.rate) {
		const probe = await venue.probe(c.ask.srcToken.destToken, 10n ** BigInt(c.ask.srcToken.decimals))
		if (!probe.ok || probe.probe.probeOut <= 0n) return gasFailure(c)
		c.rate = probe.probe
	}
	const slice = c.deps.slice(c.ask, delivered, c.rate)
	if (slice === "pricing") return unavailable("pricing")
	return slice === null || slice <= 0n ? noRoute(NO_GAS_ROUTE) : slice
}

async function gasAt(c: RouteCtx, delivered: bigint): Promise<(CrossChainGas & { swapData: Hex }) | Outcome | undefined> {
	if (c.ask.intent === "token") return undefined
	if (!c.venue) return noRoute(NO_GAS_ROUTE)
	const slice = await sliceOf(c, c.venue.provider, delivered)
	if (typeof slice !== "bigint") return slice
	const q = await c.venue.provider.quote(c.ask.srcToken.destToken, slice)
	if (!q.ok) return gasFailure(c)
	const venue: FuelProvider = q.quote.provider === "lifi" ? { provider: "lifi", tool: q.quote.tool } : { provider: "testnetSwapper" }
	return { fuelAmount: slice, minFuelOutput: q.quote.minOut, expectedOut: q.quote.expectedOut, venue, swapData: q.quote.swapData }
}

interface RouterCallAt {
	intent: RouterIntent
	swapData: Hex
	gas?: CrossChainGas
	routerCall: Hex
	delivered: bigint
}

/** The router call for a delivery of exactly `delivered`, which bounds the pull on both sides (Across delivers
 *  exactly its output amount). */
async function routerCallAt(c: RouteCtx, delivered: bigint): Promise<RouterCallAt | Outcome> {
	const leg = await gasAt(c, delivered)
	if (leg && "answer" in leg) return leg
	const swapData = leg?.swapData ?? "0x"
	const gas = leg && { fuelAmount: leg.fuelAmount, minFuelOutput: leg.minFuelOutput, expectedOut: leg.expectedOut, venue: leg.venue }
	const fuel =
		leg && c.secrets.fuel ? { secretHash: c.secrets.fuel.secretHash, slice: leg.fuelAmount, minOutput: leg.minFuelOutput } : undefined
	const intent = crossChainIntent(c.ask.srcToken.destToken, {
		isPrivate: c.ask.isPrivate,
		recipient: c.ask.recipient as Hex,
		tokenSecretHash: c.secrets.tokenSecretHash,
		fuel,
	})
	const routerCall = bridgeFromCallerCall(intent, swapData, delivered, delivered)
	return { intent, swapData, ...(gas ? { gas } : {}), routerCall, delivered }
}

function expectationOf(c: RouteCtx, call: RouterCallAt, rail: RailExpectation): RouteExpectation {
	return {
		srcChainId: c.ask.srcChainId,
		user: c.ask.user,
		srcToken: c.ask.srcToken.address,
		srcAmount: c.ask.srcAmount,
		lifiTxId: c.lifiTxId,
		l1ChainId: c.b.l1ChainId,
		router: c.b.router,
		destToken: c.ask.srcToken.destToken,
		feeAsset: c.b.feeAsset,
		routerCall: call.routerCall,
		...(call.gas ? { fuel: call.gas.venue } : {}),
		rail,
	}
}

async function acrossTerms(c: RouteCtx, across: AcrossClient, draft: RouterCallAt, nowSec: number) {
	const book = c.deps.book ?? lifiBook
	const draftRail = {
		kind: "acrossV4" as const,
		outputAmount: c.ask.srcAmount,
		quoteTimestamp: nowSec,
		fillDeadline: nowSec + DRAFT_WINDOW_S,
	}
	return acrossSuggestedFees(
		across,
		{
			originChainId: c.ask.srcChainId,
			destinationChainId: c.b.l1ChainId,
			inputToken: c.ask.srcToken.address,
			outputToken: c.ask.srcToken.destToken,
			amount: c.ask.srcAmount,
			recipient: book(c.b.l1ChainId).receiverAcrossV4,
			message: acrossMessageOf(expectationOf(c, draft, draftRail)),
			spokePool: book(c.ask.srcChainId).acrossSpokePool,
			destinationSpokePool: book(c.b.l1ChainId).acrossSpokePool,
		},
		nowSec,
	)
}

function withinLimits(amount: bigint, limits: AcrossLimits): boolean {
	return amount >= limits.minDeposit && amount <= limits.maxDeposit
}

interface Terms {
	rail: RailTerms
	limits: AcrossLimits | null
}

/** Across's quote for the draft's message or, where the deps can time them, fixed terms when it quotes none. */
async function termsOf(c: RouteCtx, across: AcrossClient, draft: RouterCallAt): Promise<Terms | Outcome> {
	const fees = await acrossTerms(c, across, draft, (c.deps.nowSec ?? (() => Math.floor(Date.now() / 1000)))())
	if (fees.ok) {
		const { outputAmount, quoteTimestamp, fillDeadline, limits, estimatedFillTimeSec } = fees.quote
		if (!withinLimits(c.ask.srcAmount, limits)) return noRoute("The amount is outside what Across relays.")
		const etaSeconds = Math.ceil(estimatedFillTimeSec)
		return { rail: { quote: "across", outputAmount, quoteTimestamp, fillDeadline, etaSeconds }, limits }
	}
	if (!c.deps.sourceHeadSec) return noRoute(`Across quotes no relay for this deposit (${fees.reason}).`)
	const head = await c.deps.sourceHeadSec(c.ask.srcChainId)
	return { rail: selfBuiltTerms(c.b.l1ChainId, c.ask.srcAmount, head), limits: null }
}

async function quoteAcross(c: RouteCtx, across: AcrossClient): Promise<Outcome> {
	const draft = await routerCallAt(c, c.ask.srcAmount)
	if ("answer" in draft) return draft
	const terms = await termsOf(c, across, draft)
	if ("answer" in terms) return terms
	const { outputAmount, quoteTimestamp, fillDeadline, etaSeconds } = terms.rail
	const call = await routerCallAt(c, outputAmount)
	if ("answer" in call) return call
	const x = expectationOf(c, call, { kind: "acrossV4", outputAmount, quoteTimestamp, fillDeadline })
	const tx = acrossRouteTx(x)
	const verdict = verifyRoute(tx, x)
	if (!verdict.ok) return settle({ kind: "refused", field: verdict.field, reason: verdict.reason })
	const { intent, swapData, gas } = call
	const route = { lifiTxId: c.lifiTxId, secrets: c.secrets, intent, swapData, gas, minReceived: outputAmount, maxPull: outputAmount }
	const quoted = terms.rail.quote === "across" ? "quoted" : "fixed"
	return settle({ kind: "route", route: { ...route, x, tx, etaSeconds, fillDeadline, limits: terms.limits, terms: quoted } })
}

/** One ask's route, or why there is none. Throws only on an RPC or API failure the caller retries. */
export async function quoteCrossChainRoute(ask: CrossChainAsk, deps: RouteDeps): Promise<Outcome> {
	const b = deps.bindings
	if (!b) return unavailable("This bridge generation has no deposit router.")
	if (ask.rail !== "acrossV4") return unavailable("This build routes only through Across.")
	if (!deps.across) return unavailable("This build has no Across API.")
	const random = deps.random ?? Fr.random
	const lifiTxId = random().toString() as Hex
	const secrets = await crossChainSecrets(ask.intent, ask.isPrivate, ask.recipient, random)
	const fuel = ask.intent === "token" ? undefined : deps.fuel(lifiTxId)
	const venue = fuel?.provider ? { provider: fuel.provider, reverted: fuel.reverted } : undefined
	return quoteAcross({ ask, deps, b, lifiTxId, secrets, venue }, deps.across)
}

/** This build's bindings, Across API and Ethereum reader. */
export function appRouteDeps(slice: SliceSizer): RouteDeps {
	const target = resolveToolsTarget()
	const ethereum = readClientFor(NETWORK.l1ChainId)
	return {
		bindings: SEND_GENERATION
			? { l1ChainId: NETWORK.l1ChainId, router: SEND_GENERATION.router, feeAsset: SEND_GENERATION.feeAsset }
			: undefined,
		across: target.acrossApiUrl
			? { fetch: ((input, init) => fetch(input, init)) as typeof fetch, base: target.acrossApiUrl }
			: undefined,
		fuel: (lifiTxId) => (ethereum ? fuelProviderOn(ethereum, lifiTxId) : { provider: undefined, reverted: () => false }),
		slice,
		...(IS_MAINNET ? {} : { sourceHeadSec }),
	}
}

async function sourceHeadSec(chainId: number): Promise<number> {
	const reader = readClientFor(chainId)
	if (!reader) throw new Error(`This build has no reader for chain ${chainId}.`)
	return Number((await reader.getBlock({ blockTag: "latest" })).timestamp)
}

export interface QuotedRoute {
	readonly ask: CrossChainAsk
	readonly outcome: CrossChainRouteOutcome
	/** When the answer landed, for the TTL. */
	readonly at: number
}

export interface UseCrossChainRouteHandle {
	readonly quoted: ComputedRef<QuotedRoute | null>
	readonly loading: Ref<boolean>
	readonly error: Ref<string | null>
	quote: (ask: CrossChainAsk) => Promise<void>
	/** The quoted route while it is younger than `ROUTE_TTL_MS`; null once it must be quoted again. */
	fresh: () => QuotedRoute | null
	dispose: () => void
}

export function useCrossChainRoute(deps: RouteDeps, o: { now?: () => number } = {}): UseCrossChainRouteHandle {
	const core = latestQuote((ask: CrossChainAsk) => quoteCrossChainRoute(ask, deps), {
		debounceMs: DEBOUNCE_MS,
		ttlMs: ROUTE_TTL_MS,
		now: o.now,
	})
	const view = (a: ReturnType<typeof core.fresh>): QuotedRoute | null => (a ? { ask: a.question, outcome: a.answer, at: a.at } : null)
	return {
		quoted: computed(() => view(core.answered.value)),
		loading: core.loading,
		error: core.error,
		quote: core.ask,
		fresh: () => view(core.fresh()),
		dispose: core.dispose,
	}
}
