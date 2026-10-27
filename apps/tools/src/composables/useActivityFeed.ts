import { type AnyJournalRecord, isCrossChainRecord } from "@unleashed/bridge-core"
import { computed } from "vue"
import {
	type ActivityAction,
	type ActivityGroup,
	ageFrom,
	ageSpoken,
	ageWords,
	classify,
	groupRecords,
	needsYouCount,
	type RecordStatus,
	routeWords,
	rowStrings,
	runningWord,
	statusPhase,
	visibilityWords,
} from "@/lib/activity"
import { useNow } from "@/lib/clock"
import { currentRowParts, type DockWord, dockWord, phaseChip, phaseDetail } from "@/lib/crosschain-activity"
import { type RecordState, recordState } from "@/lib/record-policy"
import { type RecordRuntime, useBridgeJournal } from "./useBridgeJournal"
import { useBridgeWallet } from "./useBridgeWallet"
import { useShell } from "./useShell"

export interface ActivityRowModel {
	id: string
	createdAt: number
	direction: "deposit" | "withdraw"
	status: RecordStatus
	group: ActivityGroup
	action: ActivityAction
	/** The record the wizard's stepper is showing ("this send"). */
	foreground: boolean
	/** The record on screen beside the dock: the foreground one, or a receipt reopened from Activity. */
	current: boolean
	/** Counts toward the needs-you badge; any row but the foreground one may also open the dock by itself. */
	counts: boolean
	/** The canonical account a SWITCH row switches to; null unless the action is `switch`. */
	switchTarget: string | null
	/** A running record's word: its live phase, proving named as the activity it is. */
	phase: string
	amount: string
	symbol: string
	/** Shown with a gross amount (`amountQualifier`); null for any other. */
	qualifier: string | null
	route: string
	visibility: string
	age: string
	/** The age as a screen reader says it ("2 days ago"). */
	ageSpoken: string
	/** A cross-chain send's own word and tone, which replace the status's; null for any other row. */
	word?: DockWord | null
	/** Replaces visibility and age on the second line ("refund pending"); null for any other row. */
	detail?: string | null
	/** A line of its own under the route ("another deposit found"); null for any other row. */
	note?: string | null
}

const ANOTHER_DEPOSIT = "another deposit found"

/** The cross-chain parts of a row: what replaces the status word, the second line and the note. A
 *  send in flight reads as its live phase (`live`); a failed record keeps its status's word, as an
 *  Ethereum-origin one does. */
function crossChainParts(rec: AnyJournalRecord, state: RecordState, visibility: string, live: DockWord | null, foreground: boolean) {
	if (!isCrossChainRecord(rec)) return {}
	const note = !state.crossChain && (rec.route.extraDeposits?.length ?? 0) > 0 ? ANOTHER_DEPOSIT : null
	const phase = statusPhase(state)
	if (!phase) return live ? { word: live, note } : { note }
	if (foreground) return { ...currentRowParts(rec, phase, live), note }
	const chip = phaseChip(phase)
	return { word: live ?? { text: chip.word, tone: chip.tone }, detail: phaseDetail(phase, visibility), note }
}

/** A cross-chain send's live phase as the dock words it. The "this send" row names the claim it
 *  waits on, as its stepper does; anywhere else a claim is a button. */
function liveWord(rec: AnyJournalRecord, rt: RecordRuntime, status: RecordStatus, foreground: boolean, at: number): DockWord | null {
	if (!isCrossChainRecord(rec)) return null
	return status === "running" || (foreground && status === "needs-you") ? dockWord(rec, rt, at) : null
}

/**
 * The dock's one data source: every record, read through the shared policy. The record the wizard
 * is showing joins as the "this send" row in its own group, with its action and its count; only a
 * delivered send's Continue stays a word, since the panel beside the dock carries that button.
 * Everything reactive is read inside the computed, the clock included, so a row's age ticks and an
 * engine patch re-derives its row.
 */
export function useActivityFeed() {
	const journal = useBridgeJournal()
	const wallet = useBridgeWallet()
	const shell = useShell()
	const now = useNow()

	const rows = computed<ActivityRowModel[]>(() => {
		const view = { status: wallet.status.value, selectedAccount: wallet.selectedAccount.value, accounts: wallet.accounts.value }
		const at = now.value
		const shownId = shell.receiptFromActivity.value
		const toRow = (rec: AnyJournalRecord, foreground: boolean): ActivityRowModel => {
			const rt = journal.runtime.value[rec.id] ?? {}
			const state = recordState(rec, rt, view)
			const c = classify(rec, state)
			const action = foreground && c.action === "continue" ? null : c.action
			const visibility = visibilityWords(rec)
			const live = liveWord(rec, rt, c.status, foreground, at)
			return {
				id: rec.id,
				createdAt: rec.createdAt,
				direction: rec.direction,
				status: c.status,
				group: c.group,
				action,
				foreground,
				current: foreground || rec.id === shownId,
				counts: c.counts,
				switchTarget: action === "switch" ? state.switchTarget : null,
				phase: runningWord(rec, rt),
				...rowStrings(rec, state.crossChain),
				route: routeWords(rec),
				visibility,
				age: ageWords(ageFrom(rec), at),
				ageSpoken: ageSpoken(ageFrom(rec), at),
				...crossChainParts(rec, state, visibility, live, foreground),
			}
		}
		const listed = journal.visibleRecords.value.map((rec) => toRow(rec, false))
		const fg = journal.listedRecords.value.find((r) => r.id === journal.activeFlowId.value)
		return fg ? [...listed, toRow(fg, true)] : listed
	})

	const grouped = computed(() => groupRecords(rows.value))
	const count = computed(() => needsYouCount(rows.value))
	/** Ids the dock may open itself for: the rows the badge counts, but for the send already on screen. */
	const autoOpenIds = computed(() => rows.value.filter((r) => r.counts && !r.foreground).map((r) => r.id))
	const liveIds = computed(() => new Set(journal.listedRecords.value.map((r) => r.id)))

	return { rows, grouped, count, autoOpenIds, liveIds }
}

export type ActivityFeed = ReturnType<typeof useActivityFeed>
