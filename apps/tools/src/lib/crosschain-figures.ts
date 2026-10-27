/**
 * What a priced cross-chain route means in the source token's units: what the rail delivers on Ethereum, the relay
 * fee it keeps, the gas slice, and the token that arrives on Aztec. No price source exists, so nothing here is in
 * dollars. Pure: the amount step, the review and the fee ceiling read the same figures.
 */
import type { CrossChainAsk, CrossChainRoute } from "@/composables/useCrossChainRoute"
import { chainLabel, type Rail, railLabel } from "./chains"
import { formatAmount } from "./format"
import { IS_MAINNET, readChainOf } from "./network"

/** A token send whose relay fee is more than this share of it is refused on mainnet and only warned about on testnet. */
export const FEE_CEILING_BPS = 1000

/** The relay fee also grows a little with the amount, so the suggested minimum carries this margin over the ceiling. */
const MINIMUM_MARGIN_PERCENT = 102n

export interface CrossChainFigures {
	srcAmount: bigint
	/** What the rail delivers to the router on Ethereum; on Across, exactly. */
	delivered: bigint
	/** Taken from the amount on the source chain: `srcAmount − delivered`. */
	relayFee: bigint
	/** `relayFee` as a share of `srcAmount`, in basis points. */
	feeBps: number
	/** Source-token units the router swaps into gas; null for a token-only send. */
	slice: bigint | null
	/** The token that arrives on Aztec; null for a gas-only send. */
	tokenArrives: bigint | null
	/** The venue's estimate and the floor the swap is signed against, in Fee Juice; null without a gas leg. */
	gasExpected: bigint | null
	gasFloor: bigint | null
	etaSeconds: number
	/** Seconds from the quote to the fill deadline: how long an undelivered send waits before its refund. */
	refundAfterSeconds: number | null
	/** Across's bounds on the amount; null on fixed terms. */
	limits: { min: bigint; max: bigint } | null
	/** Built on fixed testnet terms: the relay fee is a fixed share and the fill is manual. */
	fixed: boolean
}

export function figuresOf(ask: Pick<CrossChainAsk, "srcAmount" | "intent">, route: CrossChainRoute): CrossChainFigures {
	const delivered = route.minReceived
	const relayFee = ask.srcAmount > delivered ? ask.srcAmount - delivered : 0n
	const slice = route.gas?.fuelAmount ?? null
	const rest = delivered - (slice ?? 0n)
	const rail = route.x.rail
	return {
		srcAmount: ask.srcAmount,
		delivered,
		relayFee,
		feeBps: ask.srcAmount > 0n ? Number((relayFee * 10_000n) / ask.srcAmount) : 0,
		slice,
		tokenArrives: ask.intent === "gas" ? null : rest > 0n ? rest : 0n,
		gasExpected: route.gas?.expectedOut ?? null,
		gasFloor: route.gas?.minFuelOutput ?? null,
		etaSeconds: route.etaSeconds,
		refundAfterSeconds: rail.kind === "acrossV4" ? Math.max(0, route.fillDeadline - rail.quoteTimestamp) : null,
		limits: route.limits && { min: route.limits.minDeposit, max: route.limits.maxDeposit },
		fixed: route.terms === "fixed",
	}
}

/** "9.8 %": one decimal, as every fee share is shown. */
export function feeShareText(bps: number): string {
	return `${(bps / 100).toFixed(1)} %`
}

export interface FeeCeiling {
	/** The relay fee is over `FEE_CEILING_BPS` of the send. */
	over: boolean
	/** The send may not continue: a token send over the ceiling on mainnet. */
	blocks: boolean
	/** The smallest amount whose fee should sit under the ceiling, never under the rail's own minimum. */
	minimum: bigint
}

const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b

/** Rounded up to whole units, or to hundredths under one unit: a figure the user can type and that clears the ceiling. */
function roundUp(value: bigint, decimals: number): bigint {
	const whole = 10n ** BigInt(decimals)
	const step = value >= whole || decimals <= 2 ? whole : 10n ** BigInt(decimals - 2)
	return ceilDiv(value, step) * step
}

/** A gas-only send is never refused (its fee is a cost of the gas, not a cut of a token), and testnet only warns. */
export function feeCeilingOf(f: CrossChainFigures, decimals: number, o: { intent: CrossChainAsk["intent"]; mainnet: boolean }): FeeCeiling {
	const over = f.relayFee * 10_000n > f.srcAmount * BigInt(FEE_CEILING_BPS)
	const target = ceilDiv(f.relayFee * 10_000n * MINIMUM_MARGIN_PERCENT, BigInt(FEE_CEILING_BPS) * 100n)
	const floor = f.limits?.min ?? 0n
	const minimum = roundUp(target > floor ? target : floor, decimals)
	return { over, blocks: over && o.mainnet && o.intent !== "gas", minimum }
}

/** "2 hours", "1 hour", "45 minutes": the refund wait, in the unit a person reads it in. */
export function waitText(seconds: number): string {
	if (seconds >= 3600) {
		const hours = Math.round(seconds / 3600)
		return `${hours} ${hours === 1 ? "hour" : "hours"}`
	}
	const minutes = Math.max(1, Math.round(seconds / 60))
	return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`
}

/** "≈ 0.49 USDC": a fee or a delivery in the source token, at two places unless smaller than that. */
export function approxText(value: bigint, decimals: number, symbol: string): string {
	return `≈ ${formatAmount(value, decimals)} ${symbol}`
}

/** "≈ 0.49 USDC · 9.8 %"; a gas-only send's fee is a cost of the gas, not a share of a token, so it has no share. */
export function feeTotalText(f: CrossChainFigures, decimals: number, symbol: string, intent: CrossChainAsk["intent"]): string {
	const total = approxText(f.relayFee, decimals, symbol)
	return intent === "gas" ? total : `${total} · ${feeShareText(f.feeBps)}`
}

/** The two lines every cross-chain fee breaks into: the rail's cut of the amount, and the source chain's own fee. */
export function feeLineLabels(srcChainId: number, rail: Rail): { relay: string; network: string } {
	const native = readChainOf(srcChainId)?.chain.nativeCurrency.symbol ?? "ETH"
	return {
		relay: `${railLabel(rail)} relay fee, taken from the amount`,
		network: `Paid in ${IS_MAINNET ? "" : "test "}${native} on ${chainLabel(srcChainId)}`,
	}
}

/** How the countdowns name what they count down: Across's quote is refreshed, fixed terms are rebuilt. */
export function quoteWord(f: Pick<CrossChainFigures, "fixed">): { valid: string; renewed: string } {
	return f.fixed ? { valid: "Terms", renewed: "rebuilt" } : { valid: "Quote", renewed: "refreshed" }
}

/** Testnet sends ride fixed terms, never a quote, so their retries say "terms"; mainnet keeps the boards' quote words. */
export const RETRY_WORDS = IS_MAINNET
	? {
			getNew: "Get a new quote",
			tryAgain: "Try again with a new quote; routes change from minute to minute.",
			signAgain: "Get a new quote and sign again.",
		}
	: { getNew: "Get new terms", tryAgain: "Try again with new terms.", signAgain: "Get new terms and sign again." }

/** "0:42": a quote's remaining life, never negative. */
export function countdownText(ms: number): string {
	const total = Math.max(0, Math.ceil(ms / 1000))
	return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`
}
