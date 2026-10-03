/**
 * The one reading of a record that the card, the dock row, the needs-you count and the page order
 * share. A persisted `blocked` or any runtime attention overrides completion; completion overrides a
 * stale busy runtime; ownership moves group and count, never status.
 */
import { type BridgeJournalRecord, type DepositJournalRecord, assetKindOf } from "@unleashed/bridge-core"
import type { RecordRuntime } from "@/composables/useBridgeJournal"
import { amountQualifier, displayAmountOf, displayAmountText } from "@/lib/asset-label"
import { type BridgePhase, isFailedAttention, stepperPhases } from "@/lib/bridge-steps"
import type { RecordState } from "@/lib/record-policy"

/** The status chip's word and the card's edge colour. */
export type RecordStatus = "lost" | "running" | "done" | "needs-you"
export type ActivityGroup = "needs-you" | "running" | "done" | "other-account"
export type ActivityAction = "claim" | "finish" | "retry" | "claim-gas" | "switch" | null

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

/** Persisted completion metadata is taken as stored here, never re-verified on-chain. */
function statusOf(rec: BridgeJournalRecord, s: RecordState): RecordStatus {
	if (s.blocked !== undefined || isFailedAttention(s.attention)) return "lost"
	if (rec.completedAt !== undefined || s.stage === "done") return "done"
	return s.busy ? "running" : "needs-you"
}

function actionOf(rec: BridgeJournalRecord, s: RecordState): ActivityAction {
	if (rec.completedAt !== undefined || s.stage === "done") return doneAction(s)
	return s.busy ? null : openAction(s)
}

export function classify(rec: BridgeJournalRecord, s: RecordState): Classified {
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

/** Lost records first (they share Needs you with the claims), then newest first inside each group. */
export function groupRecords<T extends { group: ActivityGroup; createdAt: number; status?: RecordStatus }>(
	rows: readonly T[],
): GroupedRows<T> {
	const lostFirst = (r: T) => (r.status === "lost" ? 0 : 1)
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

/** A running record's chip word: its live phase, with proving named as the activity it is. */
export function runningWord(rec: BridgeJournalRecord, rt: RecordRuntime): string {
	const live = livePhase(rec, rt)
	if (!live) return "Running"
	return live.key === "prove" ? "Proving" : live.label
}

export function routeWords(rec: BridgeJournalRecord): string {
	return rec.direction === "deposit" ? "ETH → Aztec" : "Aztec → ETH"
}

function buysGas(rec: BridgeJournalRecord): boolean {
	if (rec.direction !== "deposit" || assetKindOf(rec) === "fee-juice") return false
	if ("intent" in rec) return rec.intent === "token+gas"
	return (rec as DepositJournalRecord).fuel !== undefined
}

/** "private + gas" / "public": the visibility and whether a gas leg rides along, as words. */
export function visibilityWords(rec: BridgeJournalRecord): string {
	return `${rec.isPrivate ? "private" : "public"}${buysGas(rec) ? " + gas" : ""}`
}

/** Amount, symbol and qualifier for a row, read as every record surface reads them (`displayAmountOf`). */
export function rowStrings(rec: BridgeJournalRecord): { amount: string; symbol: string; qualifier: string | null } {
	const d = displayAmountOf(rec)
	return { amount: displayAmountText(d), symbol: d.symbol, qualifier: amountQualifier(d) }
}

export function ageWords(createdAt: number, now: number): string {
	const mins = Math.max(0, Math.round((now - createdAt) / 60_000))
	if (mins < 1) return "just now"
	if (mins < 60) return `${mins}m ago`
	const hours = Math.round(mins / 60)
	return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`
}
