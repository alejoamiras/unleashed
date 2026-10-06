/**
 * The wizard's shared vocabulary: what a token is at each stage of selection, what a send is once
 * the user has chosen, and the outcomes the grant and route steps can produce. Every composable
 * and every step component speaks these types; none of them re-declares a token shape of its own.
 */
import type { FuelProvider, Registration, TokenState } from "@unleashed/bridge-core"
import type { Address, Hex } from "viem"
import { formatCompact } from "./format"

export type Direction = "l1-to-l2" | "l2-to-l1"

/** What the user wants out of a deposit: the token, the token plus gas, or gas alone. */
export type SendIntent = "token" | "token+gas" | "gas"

export type TokenSource = "manifest" | "list" | "pasted"

/** A token the wizard can act on before anything is read from the chain. */
export interface SelectableToken {
	chainId: number
	/** Lowercase. */
	address: Address
	symbol: string
	name: string
	decimals: number
	source: TokenSource
	/** `${chainId}:${address}` — a committed brand mark is keyed by identity, never by symbol. */
	logoKey: string
}

/** What the amount step needs to render a field: the catalog row has it before the chain is read. */
export type AmountToken = Pick<SelectableToken, "symbol" | "decimals">

/** The shape `SelectableToken.logoKey` carries: a committed brand mark is keyed by identity, never by symbol. */
export const logoKeyOf = (chainId: number, address: string): string => `${chainId}:${address}`

/** The L1-attested words the hub derives the L2 token from. */
export interface TokenWords {
	nameWord: Hex
	symbolWord: Hex
}

/** What a token says its identity is, from one source. */
export interface TokenIdentity {
	symbol: string
	name: string
	decimals: number
}

/** A listed identity the token contract itself contradicts. Set only when the two disagree; the
 *  resolved token then carries the LIVE values and the review names the disagreement. */
export interface MetadataConflict {
	listed: TokenIdentity
	live: TokenIdentity
}

/**
 * A selected token with everything the review and the send need. For a first-time token the
 * words and `l2Token` are a PREVIEW from sanitized live metadata; the receipt re-reads the
 * factory's frozen registration and the journal carries that, never this.
 */
export interface ResolvedToken extends SelectableToken {
	state: TokenState
	portal: Address
	words: TokenWords
	l2Token: Hex
	registration?: Registration
	metadataConflict?: MetadataConflict
}

export interface TokenBalances {
	l1?: bigint
	l2Public?: bigint
	l2Private?: bigint
}

/**
 * - `declined`: the wallet answered and the token is not in the grant.
 * - `stale`: the selection moved on while the wallet was deciding.
 * - `busy`: the wallet never saw the request — another flow owned it. Nothing was refused.
 */
export type GrantOutcome = "granted" | "declined" | "stale" | "busy"

export interface GasLegPlan {
	fuelAmount: bigint
	fuelFj: bigint
	/** What the probe says `fuelAmount` buys — display + floor input, never the claim amount. */
	quote: bigint
	minFuelOutput: bigint
	/** Where the slice is swapped; null for the fee asset, which needs no swap. */
	venue: FuelProvider | null
	capped: "min" | "half" | null
}

/** The token part of a deposit that arrives on Aztec: the amount less its gas slice, never below zero. */
export function tokenRemainder(amount: bigint, gas: Pick<GasLegPlan, "fuelAmount"> | null | undefined): bigint {
	const slice = gas?.fuelAmount ?? 0n
	return amount > slice ? amount - slice : 0n
}

/** Who swaps a gas slice: LI.FI names the venue its quote routed through. `tool` is provider-supplied text, so the
 *  caller strips it for display. */
export function venueText(venue: FuelProvider, display: (s: string) => string): string {
	return venue.provider === "lifi" ? `LI.FI (${display(venue.tool)})` : "the testnet fuel swapper"
}

/** Why a send cannot include gas when no fuel venue is reachable on this network. */
export const NO_GAS_ROUTE = "No route can buy Aztec gas on this network right now, so this send can't include gas."

/** A token + gas split whose slice would take the whole amount. */
export const GAS_TOO_SMALL = "The amount is too small to buy gas and still send a token."

/** A private claim forfeits its fee ceilings before any gas reaches the user, so a slice whose guaranteed floor
 *  cannot cover them would cross only for the claim to refuse it, after the deposit is irreversible. */
export const PRIVATE_SLICE_SHORT =
	"The gas slice is too small to cover the fees a private claim sets aside — send a larger amount, or send it publicly."

/** The bridge refuses gas under its claim minimum on Ethereum (the swap reverts at the router's floor), so a quote
 *  under it is a deposit that cannot go through; null when the quote clears it. */
export function gasMinimumShortfall(quote: bigint, minFuelFj: bigint): string | null {
	if (quote >= minFuelFj) return null
	return `This amount buys only ≈ ${formatCompact(quote, 18)} FJ of gas, under the ≈ ${formatCompact(minFuelFj, 18)} FJ minimum a claim needs — send a larger amount.`
}

/** A route outcome that closes both gas choices. */
export type GasBlock = "no-route" | "unavailable"

export const GAS_BLOCK_REASON: Record<GasBlock, string> = {
	"no-route": "This token can't buy Aztec gas on the way in.",
	unavailable: "Gas options can't be checked right now.",
}

export interface ChoiceHintState {
	exit: boolean
	/** Transactions the token + gas slice is sized for. */
	txTarget: number
	gasBlock: GasBlock | null
	/** The token alone cannot be claimed: the account holds no gas. */
	tokenBlocked: boolean
}

/** A phone row's short hint; `count`, when present, sits between `lead` and `tail` as a figure. */
export interface ChoiceHint {
	lead: string
	count?: number
	tail?: string
}

/** The one-line hint a phone row shows in place of its caption: what arrives, or why it cannot. */
export function hintOf(choice: SendIntent, s: ChoiceHintState): ChoiceHint {
	if (choice === "token") {
		if (s.exit) return { lead: "back to Ethereum" }
		return { lead: s.tokenBlocked ? "needs gas first" : "only the token" }
	}
	if (s.gasBlock) return { lead: s.gasBlock === "no-route" ? "not for this token" : "can't check right now" }
	if (choice === "gas") return { lead: "all of it as gas" }
	return { lead: "gas for ", count: s.txTarget, tail: s.txTarget === 1 ? " transaction" : " transactions" }
}

/** Everything "Sign and send" acts on. */
export interface SendPlan {
	direction: "l1-to-l2"
	intent: SendIntent
	token: ResolvedToken
	amount: bigint
	isPrivate: boolean
	gas?: GasLegPlan
}

export interface ExitPlan {
	direction: "l2-to-l1"
	token: ResolvedToken
	amount: bigint
	isPrivate: boolean
	recipientL1: Address
}
