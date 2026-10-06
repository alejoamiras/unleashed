import { type AnyJournalRecord, isCrossChainRecord } from "@unleashed/bridge-core"
import { computed } from "vue"
import {
	type ActivityAction,
	type ActivityGroup,
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
import { type CrossChainTone, phaseChip, phaseDetail } from "@/lib/crosschain-activity"
import { type RecordState, recordState } from "@/lib/record-policy"
import { useBridgeJournal } from "./useBridgeJournal"
import { useBridgeWallet } from "./useBridgeWallet"

export interface ActivityRowModel {
	id: string
	createdAt: number
	direction: "deposit" | "withdraw"
	status: RecordStatus
	group: ActivityGroup
	action: ActivityAction
	/** The record the wizard's stepper is showing: listed read-only, never counted. */
	foreground: boolean
	/** Counts toward the needs-you badge and may open the dock by itself. */
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
	/** A cross-chain phase's own word and tone, which replace the status's; null for any other row. */
	word?: { text: string; tone: CrossChainTone } | null
	/** Replaces visibility and age on the second line ("refund pending"); null for any other row. */
	detail?: string | null
	/** A line of its own under the route ("another deposit found"); null for any other row. */
	note?: string | null
}

const ANOTHER_DEPOSIT = "another deposit found"

/** The cross-chain parts of a row: what replaces the status word, the second line and the note. A
 *  failed record keeps its status's word, as an Ethereum-origin one does. */
function crossChainParts(rec: AnyJournalRecord, state: RecordState, visibility: string) {
	if (!isCrossChainRecord(rec)) return {}
	const note = !state.crossChain && (rec.route.extraDeposits?.length ?? 0) > 0 ? ANOTHER_DEPOSIT : null
	const phase = statusPhase(state)
	if (!phase) return { note }
	const chip = phaseChip(phase)
	return { word: { text: chip.word, tone: chip.tone }, detail: phaseDetail(phase, visibility), note }
}

/**
 * The dock's one data source: every record, read through the shared policy. The record the wizard
 * is showing joins as a read-only "this send" row under Running: its stepper stays the one place to
 * act on it, so the row carries no action and neither counts nor opens the dock. Everything
 * reactive is read inside the computed, the clock included, so a row's age ticks and an engine
 * patch re-derives its row.
 */
export function useActivityFeed() {
	const journal = useBridgeJournal()
	const wallet = useBridgeWallet()
	const now = useNow()

	const rows = computed<ActivityRowModel[]>(() => {
		const view = { status: wallet.status.value, selectedAccount: wallet.selectedAccount.value, accounts: wallet.accounts.value }
		const at = now.value
		const toRow = (rec: AnyJournalRecord, foreground: boolean): ActivityRowModel => {
			const rt = journal.runtime.value[rec.id] ?? {}
			const state = recordState(rec, rt, view)
			const c = classify(rec, state)
			const action = foreground ? null : c.action
			const visibility = visibilityWords(rec)
			return {
				id: rec.id,
				createdAt: rec.createdAt,
				direction: rec.direction,
				status: c.status,
				group: foreground ? "running" : c.group,
				action,
				foreground,
				counts: !foreground && c.counts,
				switchTarget: action === "switch" ? state.switchTarget : null,
				phase: runningWord(rec, rt),
				...rowStrings(rec, state.crossChain),
				route: routeWords(rec),
				visibility,
				age: ageWords(rec.createdAt, at),
				...crossChainParts(rec, state, visibility),
			}
		}
		const listed = journal.visibleRecords.value.map((rec) => toRow(rec, false))
		const fg = journal.listedRecords.value.find((r) => r.id === journal.activeFlowId.value)
		return fg ? [...listed, toRow(fg, true)] : listed
	})

	const grouped = computed(() => groupRecords(rows.value))
	const count = computed(() => needsYouCount(rows.value))
	/** Ids the dock may open itself for: exactly the rows the badge counts. */
	const autoOpenIds = computed(() => rows.value.filter((r) => r.counts).map((r) => r.id))
	const liveIds = computed(() => new Set(journal.listedRecords.value.map((r) => r.id)))

	return { rows, grouped, count, autoOpenIds, liveIds }
}

export type ActivityFeed = ReturnType<typeof useActivityFeed>
