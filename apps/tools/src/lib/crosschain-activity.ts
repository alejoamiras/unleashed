/**
 * How a cross-chain record reads before its deposit lands on Ethereum, or once an outcome ends it.
 * Between those two it runs, and reads, as the schema-3 deposit it extends (`sendView`).
 */
import {
	type AnyJournalRecord,
	type BridgeJournalRecord,
	type CrossChainDepositRecord,
	type CrossChainOutcome,
	isCrossChainRecord,
	outcomeDecidingChain,
	outcomeFinality,
} from "@unleashed/bridge-core"
import type { RecordRuntime } from "@/composables/useBridgeJournal"
import type { EthereumPrefill } from "@/composables/useShell"
import { sourceTokenOf } from "@/composables/useSourceChain"
import { chainLabel, railLabel } from "@/lib/chains"
import { bridgingPrompt, crossChainPhases, crossChainUnconfirmed } from "@/lib/crosschain-steps"
import { formatStoredAmount } from "@/lib/format"
import { IS_MAINNET } from "@/lib/network"
import { safeAddressText, safeDisplay } from "@/lib/token-display"

/** Where a cross-chain record stands while it is not a plain deposit; `finalizing` is any outcome
 *  whose deciding block is not final yet, read on `chainId`. */
export type CrossChainPhase =
	| { kind: "sending" }
	| { kind: "bridging" }
	| { kind: "finalizing"; outcome: CrossChainOutcome; chainId: number }
	| { kind: "not-sent" }
	| { kind: "delivered" }
	| { kind: "expired" }

const FINAL_KIND: Record<CrossChainOutcome, "not-sent" | "delivered" | "expired"> = {
	"not-sent": "not-sent",
	"delivered-to-wallet": "delivered",
	"expired-on-source": "expired",
}

/** Null for an Ethereum-origin record, and for a cross-chain one once its deposit landed. */
export function crossChainPhase(rec: AnyJournalRecord): CrossChainPhase | null {
	if (!isCrossChainRecord(rec)) return null
	const outcome = rec.route.outcome
	if (outcome) {
		return outcomeFinality(rec) === "provisional"
			? { kind: "finalizing", outcome, chainId: outcomeDecidingChain(rec, outcome) }
			: { kind: FINAL_KIND[outcome] }
	}
	if (rec.leafIndex !== undefined || rec.completedAt !== undefined) return null
	// A hash only says the wallet broadcast the send; the rail has it once the source receipt named its transport.
	return rec.route.transport ? { kind: "bridging" } : { kind: "sending" }
}

/** The schema-3 deposit a cross-chain record extends, for every reading written before schema 4. */
export function sendView(rec: AnyJournalRecord): BridgeJournalRecord {
	return isCrossChainRecord(rec) ? ({ ...rec, schema: 3 } as unknown as BridgeJournalRecord) : rec
}

/** The tone a status chip and a dock word share: run, wait, need, lost, ended. */
export type CrossChainTone = "run" | "wait" | "need" | "lost" | "ended"

const CHIPS: Record<CrossChainPhase["kind"], { word: string; tone: CrossChainTone }> = {
	sending: { word: "Sending", tone: "run" },
	bridging: { word: "Bridging", tone: "run" },
	finalizing: { word: "Finalizing", tone: "wait" },
	"not-sent": { word: "Not sent", tone: "lost" },
	delivered: { word: "Delivered to wallet", tone: "need" },
	expired: { word: "Expired", tone: "ended" },
}

export function phaseChip(phase: CrossChainPhase): { word: string; tone: CrossChainTone } {
	return CHIPS[phase.kind]
}

/** The dock row's second line after the route, in place of visibility and age. */
export function phaseDetail(phase: CrossChainPhase, visibility: string): string {
	switch (phase.kind) {
		case "finalizing":
			return `waiting for ${chainLabel(phase.chainId)} to finalize`
		case "not-sent":
			return "nothing moved"
		case "delivered":
			return "in your Ethereum wallet"
		case "expired":
			return "refund pending"
		default:
			return visibility
	}
}

/** The asset a cross-chain record moves, named as its source token: the registry's entry first, the
 *  record's own token block after it (same asset, same decimals on both ends of a rail). */
export interface CrossChainAsset {
	symbol: string
	decimals: number
	/** The ERC-20 the rail delivers on Ethereum, lower-case; undefined when neither source names it. */
	ethereumToken: `0x${string}` | undefined
}

export function crossChainAsset(rec: CrossChainDepositRecord): CrossChainAsset {
	const listed = sourceTokenOf({ chainId: rec.route.srcChainId, address: rec.route.srcToken })?.token
	const token = "token" in rec ? rec.token : undefined
	const ethereum = token?.erc20 ?? listed?.destToken
	return {
		symbol: safeDisplay(listed?.symbol ?? token?.displaySymbol ?? "TOKEN"),
		decimals: listed?.decimals ?? token?.decimals ?? 18,
		ethereumToken: ethereum ? (ethereum.toLowerCase() as `0x${string}`) : undefined,
	}
}

/** "5.00 USDC" for a base-unit amount of the record's asset; null when the amount is unknown. */
export function assetText(rec: CrossChainDepositRecord, raw: string | undefined): string | null {
	if (raw === undefined) return null
	const asset = crossChainAsset(rec)
	return `${formatStoredAmount(raw, asset.decimals)} ${asset.symbol}`
}

/** The Ethereum-origin send that continues a deposit delivered to the wallet; null when the record names
 *  no Ethereum token to start it from. */
export function ethereumPrefillOf(rec: CrossChainDepositRecord): EthereumPrefill | null {
	const token = crossChainAsset(rec).ethereumToken
	if (!token) return null
	const delivered = rec.route.outcomeAmount
	return {
		token,
		...(delivered !== undefined && /^\d+$/.test(delivered) ? { amount: BigInt(delivered) } : {}),
		intent: rec.intent,
		isPrivate: rec.isPrivate,
		fromRecordId: rec.id,
	}
}

/** "0x3fA8…c41D": the stored address is user-writable, so it is stripped before it is shown. */
export function shortAddress(address: string): string {
	const clean = safeAddressText(address)
	return clean.length > 12 ? `${clean.slice(0, 6)}…${clean.slice(-4)}` : clean
}

/** How long the relay had before the transfer expired: "2 hours", "45 minutes"; null without a deadline. */
function windowWords(rec: CrossChainDepositRecord): string | null {
	const deadline = rec.route.fillDeadline
	if (deadline === undefined) return null
	const minutes = Math.round((deadline * 1000 - rec.createdAt) / 60_000)
	if (minutes < 1) return null
	if (minutes < 90) return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`
	const hours = Math.round(minutes / 60)
	return `${hours} hours`
}

function finalizingGuide(rec: CrossChainDepositRecord, outcome: CrossChainOutcome, chainId: number): string {
	const waiting = `waiting for ${chainLabel(chainId)} to finalize.`
	const src = chainLabel(rec.route.srcChainId)
	if (outcome === "delivered-to-wallet") return `Delivered to your Ethereum wallet, ${waiting}`
	return outcome === "expired-on-source" ? `Expired on ${src}, ${waiting}` : `Reverted on ${src}, ${waiting}`
}

/** "you hold 0.40 ETH" joins the delivered guide only when the balance was read; `runtime` words a send still
 *  being sent the way its stepper does. */
export interface GuideFacts {
	ethHeld?: string
	runtime?: RecordRuntime
}

function sendingGuide(rec: CrossChainDepositRecord, rt: RecordRuntime): string {
	const src = chainLabel(rec.route.srcChainId)
	if (crossChainUnconfirmed(rec, rt))
		return `We haven’t found your send on ${src} yet. Your wallet didn’t confirm it, so we keep looking.`
	return crossChainPhases(rec, rt).find((p) => p.state === "active")?.detail ?? `Waiting for ${src} to confirm the send…`
}

/** The card's one guide line for `phase`, worded from the record's own facts. */
export function phaseGuide(rec: CrossChainDepositRecord, phase: CrossChainPhase, facts: GuideFacts = {}): string {
	const src = chainLabel(rec.route.srcChainId)
	const who = shortAddress(rec.route.srcSender)
	const symbol = crossChainAsset(rec).symbol
	switch (phase.kind) {
		case "sending":
			return sendingGuide(rec, facts.runtime ?? {})
		case "bridging":
			return bridgingPrompt(rec, symbol)
		case "finalizing":
			return finalizingGuide(rec, phase.outcome, phase.chainId)
		case "not-sent":
			return `The send reverted on ${src}, so nothing moved. Your ${assetText(rec, rec.route.srcAmount)} is still in ${who}.`
		case "delivered": {
			const held = facts.ethHeld === undefined ? "" : `; you hold ${facts.ethHeld} ETH`
			const what = assetText(rec, rec.route.outcomeAmount) ?? `Your ${symbol}`
			return `${what} is in your Ethereum wallet ${who}, not on Aztec. Continuing from Ethereum is a new send and needs ETH there for gas${held}.`
		}
		case "expired":
			return `${expiryLead(rec)}. Refund pending on ${src}, to ${who}.`
	}
}

/** "Across’s test relayer didn’t deliver it within 2 hours". */
export function expiryLead(rec: CrossChainDepositRecord, what = "it"): string {
	const relayer = IS_MAINNET ? "relayers" : "test relayer"
	const window = windowWords(rec)
	return `${railLabel(rec.route.rail)}’s ${relayer} didn’t deliver ${what} ${window ? `within ${window}` : "in time"}`
}
