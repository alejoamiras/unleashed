/**
 * The one reading of a record that the card, the dock row, the needs-you count and the page order
 * share. A persisted `blocked` or any runtime attention overrides completion; completion overrides a
 * stale busy runtime; ownership moves group and count, never status.
 */
import { type AnyJournalRecord, type BridgeJournalRecord, isCrossChainRecord } from "@unleashed/bridge-core"
import type { RecordRuntime } from "@/composables/useBridgeJournal"
import { amountQualifier, displayAmountOf, displayAmountText, sentAmountOf } from "@/lib/asset-label"
import { type BridgePhase, isFailedAttention, stepperPhases } from "@/lib/bridge-steps"
import { crossChainAsset, type CrossChainPhase, sendView } from "@/lib/crosschain-activity"
import { chainLabel } from "@/lib/chains"
import { crossChainRoute } from "@/lib/crosschain-steps"
import { formatStoredAmount } from "@/lib/format"
import type { RecordState } from "@/lib/record-policy"

/** The status chip's word and the card's edge colour. */
export type RecordStatus = "lost" | "running" | "done" | "needs-you"
export type ActivityGroup = "needs-you" | "running" | "done" | "other-account"
export type ActivityAction = "claim" | "finish" | "retry" | "claim-gas" | "switch" | "continue" | null

export interface Classified {
	status: RecordStatus
	/** A lost record leads with needs-you on any account: under the done records a failure would
	 *  read quieter than a claim. */
	group: ActivityGroup
	/** Page order, ascending; newest first within a rank. */
	rank: number
	/** Counts toward the rail chip and the dock badge, and may open the dock by itself. */
	counts: boolean
	action: ActivityAction
}

const RANK: Record<RecordStatus | "other-account", number> = { lost: 0, "needs-you": 1, running: 2, done: 3, "other-account": 4 }

/** Done records offer only fuel recovery, and only as the card offers it: a switch when the gas
 *  belongs to another granted account, else the standalone claim. */
function doneAction(s: RecordState): ActivityAction {
	if (!s.fuelRecoverable) return null
	return s.ownedByOther ? "switch" : "claim-gas"
}

function openAction(s: RecordState): ActivityAction {
	if (s.showClaim) return s.ownedByOther ? "switch" : s.retry ? "retry" : "claim"
	if (s.showFinish) return s.retry ? "retry" : "finish"
	// Blocked, terminal, or stuck before anything was sent: a decision is owed, but only the card's
	// DISCARD can make it.
	return null
}

function failed(s: RecordState): boolean {
	return s.blocked !== undefined || isFailedAttention(s.attention)
}

/** Persisted completion metadata is taken as stored here, never re-verified on-chain. */
function statusOf(rec: AnyJournalRecord, s: RecordState): RecordStatus {
	if (failed(s)) return "lost"
	if (rec.completedAt !== undefined || s.stage === "done") return "done"
	return s.busy ? "running" : "needs-you"
}

function actionOf(rec: AnyJournalRecord, s: RecordState): ActivityAction {
	if (rec.completedAt !== undefined || s.stage === "done") return doneAction(s)
	return s.busy ? null : openAction(s)
}

/** A cross-chain phase owes a decision only once its funds sit in the Ethereum wallet; an ended one
 *  lists with the arrivals, whatever its tone. */
function classifyPhase(phase: CrossChainPhase): Classified {
	switch (phase.kind) {
		case "delivered":
			return { status: "needs-you", group: "needs-you", rank: RANK["needs-you"], counts: true, action: "continue" }
		case "not-sent":
			return { status: "lost", group: "done", rank: RANK.done, counts: false, action: null }
		case "expired":
			return { status: "done", group: "done", rank: RANK.done, counts: false, action: null }
		default:
			return { status: "running", group: "running", rank: RANK.running, counts: false, action: null }
	}
}

/** The cross-chain phase that words a record's status; a failure outranks it, as it outranks completion. */
export function statusPhase(s: RecordState): CrossChainPhase | null {
	return s.crossChain && !failed(s) ? s.crossChain : null
}

export function classify(rec: AnyJournalRecord, s: RecordState): Classified {
	const phase = statusPhase(s)
	if (phase) return classifyPhase(phase)
	const status = statusOf(rec, s)
	const group: ActivityGroup = status === "lost" ? "needs-you" : status === "needs-you" && s.ownedByOther ? "other-account" : status
	return {
		status,
		group,
		rank: RANK[group === "other-account" ? group : status],
		counts: (status === "lost" || status === "needs-you") && !s.ownedByOther,
		action: actionOf(rec, s),
	}
}

export interface GroupedRows<T extends { group: ActivityGroup; createdAt: number; status?: RecordStatus }> {
	needsYou: T[]
	running: T[]
	done: T[]
	otherAccount: T[]
}

/** Newest first inside each group, except that lost records lead the claims they share Needs you with. */
export function groupRecords<T extends { group: ActivityGroup; createdAt: number; status?: RecordStatus }>(
	rows: readonly T[],
): GroupedRows<T> {
	const lostFirst = (r: T) => (r.group === "needs-you" && r.status === "lost" ? 0 : 1)
	const by = (g: ActivityGroup) =>
		rows.filter((r) => r.group === g).sort((a, b) => lostFirst(a) - lostFirst(b) || b.createdAt - a.createdAt)
	return { needsYou: by("needs-you"), running: by("running"), done: by("done"), otherAccount: by("other-account") }
}

/** Lost and needs-you records of the active account: a decision is owed either way, and only the
 *  active account can make it. */
export function needsYouCount(rows: ReadonlyArray<{ counts: boolean }>): number {
	return rows.reduce((n, r) => (r.counts ? n + 1 : n), 0)
}

function livePhase(rec: BridgeJournalRecord, rt: RecordRuntime): BridgePhase | undefined {
	const phases = stepperPhases(rec, rt)
	return phases.find((p) => p.state === "active" || p.state === "failed") ?? phases.findLast((p) => p.state === "done")
}

/** A running record's chip word: its live phase, with proving named as the activity it is. A
 *  cross-chain record reaches the rail's mapper as itself, so the mapper can tell its phases apart. */
export function runningWord(rec: AnyJournalRecord, rt: RecordRuntime): string {
	const live = livePhase(rec as BridgeJournalRecord, rt)
	if (!live) return "Running"
	return live.key === "prove" ? "Proving" : live.label
}

export function routeWords(rec: AnyJournalRecord): string {
	if (isCrossChainRecord(rec)) return crossChainRoute(rec)
	const l1 = chainLabel(rec.chainId)
	return rec.direction === "deposit" ? `${l1} → Aztec` : `Aztec → ${l1}`
}

/** "private" / "public": the visibility as a word. */
export function visibilityWords(rec: AnyJournalRecord): string {
	return rec.isPrivate ? "private" : "public"
}

/** The moment a row's age counts from: arrival once a send finished, else when it started. */
export function ageFrom(rec: AnyJournalRecord): number {
	return rec.completedAt ?? rec.createdAt
}

export interface RowStrings {
	amount: string
	symbol: string
	qualifier: string | null
}

/**
 * Amount, symbol and qualifier for a row. A send under way, or a cross-chain one an outcome ended, shows what
 * left the wallet, as its stepper's headline does; a finished send shows what its deposit carried.
 */
export function rowStrings(rec: AnyJournalRecord, phase: CrossChainPhase | null = null): RowStrings {
	const underWay = rec.completedAt === undefined
	if (isCrossChainRecord(rec) && (phase || underWay)) {
		const asset = crossChainAsset(rec)
		return { amount: formatStoredAmount(rec.route.srcAmount, asset.decimals), symbol: asset.symbol, qualifier: null }
	}
	const view = sendView(rec)
	const d = underWay ? sentAmountOf(view) : displayAmountOf(view)
	return { amount: displayAmountText(d), symbol: d.symbol, qualifier: amountQualifier(d) }
}

type AgeUnit = "min" | "h" | "d"

function ageOf(at: number, now: number): { n: number; unit: AgeUnit } | null {
	const mins = Math.max(0, Math.round((now - at) / 60_000))
	if (mins < 1) return null
	if (mins < 60) return { n: mins, unit: "min" }
	const hours = Math.round(mins / 60)
	return hours < 24 ? { n: hours, unit: "h" } : { n: Math.round(hours / 24), unit: "d" }
}

/** A row's age as it sits beside other facts: "now", "6 min", "3 h", "2 d". */
export function ageWords(at: number, now: number): string {
	const age = ageOf(at, now)
	return age ? `${age.n} ${age.unit}` : "now"
}

/** "just now", "9 min ago": an age read as a sentence's time. */
export function agoWords(at: number, now: number): string {
	const age = ageOf(at, now)
	return age ? `${age.n} ${age.unit} ago` : "just now"
}

const SPOKEN: Record<AgeUnit, string> = { min: "minute", h: "hour", d: "day" }

/** "just now", "2 days ago": the age a screen reader speaks in place of the abbreviated one. */
export function ageSpoken(at: number, now: number): string {
	const age = ageOf(at, now)
	return age ? `${age.n} ${SPOKEN[age.unit]}${age.n === 1 ? "" : "s"} ago` : "just now"
}
