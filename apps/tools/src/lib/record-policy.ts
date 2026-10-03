/**
 * What a journal record can do right now, derived from its persisted facts, its live runtime and
 * the wallet session — the ONE source the bridge card and the activity dock both read, so a button
 * on one surface never disagrees with the other. Pure: no watcher, timer or clock lives here.
 */
import {
	type BridgeJournalRecord,
	type DepositJournalRecord,
	type WithdrawJournalRecord,
	assetKindOf,
	deriveDepositStage,
	deriveWithdrawStage,
} from "@unleashed/bridge-core"
import type { RecordRuntime } from "@/composables/useBridgeJournal"
import { isTerminalAttention } from "@/lib/bridge-steps"
import { decideStandaloneFuelRecovery, type StandaloneFuelRecovery } from "@/lib/fuel-claim-state"

export type RecordStage = ReturnType<typeof deriveDepositStage> | ReturnType<typeof deriveWithdrawStage>

/** The slice of the wallet session the policy reads; a plain snapshot so callers decide reactivity. */
export interface WalletView {
	status: string
	selectedAccount: string | null | undefined
	accounts: ReadonlyArray<{ address: string; alias?: string | null }>
}

/** A deposit's Aztec-side account as the wallet knows it. Withdraws carry none by design: their
 *  FINISH is an L1 action the account guard ignores. */
export interface RecordAccount {
	addr: string
	/** Canonical grant address — selectAccount() matches exact strings, never record casing. */
	canonical: string | null
	alias: string | null
	active: boolean
}

export interface RecordState {
	stage: RecordStage
	attention: RecordRuntime["attention"]
	blocked: string | undefined
	busy: boolean
	actionable: boolean
	showClaim: boolean
	showFinish: boolean
	/** The action is a retry: the last run ended in an error or an unknown outcome. */
	retry: boolean
	/** The record belongs to another GRANTED account: offer the switch instead of the guard's refusal. */
	ownedByOther: boolean
	switchTarget: string | null
	depositLegRecoverable: boolean
	/** A send exit with no transaction hash: FINISH searches Aztec for it. */
	exitAttachable: boolean
	isFuel: boolean
	fuelRecovery: StandaloneFuelRecovery
	fuelRecoverable: boolean
	showClaimWithoutFuel: boolean
	/** The token was claimed by another submitter. CLAIM, where still shown, verifies that on-chain
	 *  and finishes the record (or restores the ordinary claim if the marker was wrong). */
	claimedByOther: boolean
}

export function accountOf(rec: BridgeJournalRecord, wallet: WalletView): RecordAccount | null {
	if (rec.direction !== "deposit") return null
	const addr = (rec as DepositJournalRecord).recipient
	// The journal is persisted state — a tampered record can carry a non-string recipient.
	if (typeof addr !== "string" || addr.length === 0) return null
	const lower = addr.toLowerCase()
	const granted = wallet.accounts.find((a) => a.address.toLowerCase() === lower)
	return {
		addr,
		canonical: granted?.address ?? null,
		alias: granted?.alias || null,
		active: (wallet.selectedAccount ?? "").toLowerCase() === lower,
	}
}

export function stageOf(rec: BridgeJournalRecord, rt: RecordRuntime): RecordStage {
	if (rec.direction === "deposit") {
		const d = rec as DepositJournalRecord
		return deriveDepositStage(d, { claimable: rt.claimable ?? !!d.leafIndex })
	}
	return deriveWithdrawStage(rec as WithdrawJournalRecord, { proven: rt.proven ?? false })
}

/** A marker counts only on the shape the completion writes it on (a claimable record with no claim
 *  of its own); a marked, unfinished record keeps CLAIM as the verification that completes it — or,
 *  if the marker was wrong, restores the ordinary claim — whatever its fuel says. */
function claimedByOtherFacts(rec: BridgeJournalRecord): { claimedByOther: boolean; verifiable: boolean } {
	const d = rec as DepositJournalRecord
	const claimedByOther = rec.direction === "deposit" && d.claimedByOther === true && !!d.leafIndex && !!d.messageHash && !d.claimTxHash
	return { claimedByOther, verifiable: claimedByOther && rec.completedAt === undefined }
}

/** A "depositing" record is recoverable with a deposit hash (the engine re-derives the leg from the
 *  mined receipt) or, for a hub token send, without one (Ethereum is searched for the router call).
 *  A hash-less gas-only or pre-generation record is not: nothing can find it. */
function depositLegRecoverableOf(rec: BridgeJournalRecord, stage: RecordStage): boolean {
	if (rec.direction !== "deposit" || stage !== "depositing") return false
	const hashless = rec.schema === 3 && "token" in rec && !!rec.token
	return !!(rec as DepositJournalRecord).depositTxHash || hashless
}

/** A send exit with no transaction hash can be found on Aztec; a pre-generation one cannot. */
function exitAttachableOf(rec: BridgeJournalRecord, stage: RecordStage): boolean {
	if (rec.direction !== "withdraw" || stage !== "exiting" || rec.schema !== 3) return false
	return "token" in rec && !!rec.token && !(rec as { exitTxHash?: string }).exitTxHash
}

export function recordState(rec: BridgeJournalRecord, rt: RecordRuntime, wallet: WalletView): RecordState {
	const stage = stageOf(rec, rt)
	const attention = rt.attention
	const blocked = rec.blocked
	const busy = !!rt.busy
	// Every attention except a terminal one is retryable: the runs re-validate their guards, so
	// CLAIM/FINISH after fixing the cause is the recovery path.
	const actionable = !blocked && !isTerminalAttention(attention)
	const isFuel = assetKindOf(rec) === "fee-juice"
	const fuel = rec.direction === "deposit" ? (rec as DepositJournalRecord).fuel : undefined
	const depositLegRecoverable = depositLegRecoverableOf(rec, stage)
	const { claimedByOther, verifiable: claimedByOtherVerifiable } = claimedByOtherFacts(rec)
	const idle = actionable && !busy
	const showClaim =
		rec.direction === "deposit" &&
		stage !== "done" &&
		(stage !== "depositing" || depositLegRecoverable) &&
		idle &&
		(!claimedByOther || claimedByOtherVerifiable)
	const exitAttachable = exitAttachableOf(rec, stage)
	const showFinish = rec.direction === "withdraw" && stage !== "done" && (stage !== "exiting" || exitAttachable) && idle
	const retry = attention === "error" || attention === "unknown-outcome"
	const account = accountOf(rec, wallet)
	// selectAccount() rejects unless connected — a switch offered earlier would be an enabled no-op.
	const ownedByOther = wallet.status === "connected" && !!account && !account.active && account.canonical !== null
	const fuelRecovery = decideStandaloneFuelRecovery({
		isPrivate: rec.isPrivate,
		isFeeJuiceAsset: isFuel,
		schema: rec.schema,
		intent: "intent" in rec ? rec.intent : undefined,
		completedAt: rec.completedAt,
		claimedByOther,
		fuel,
	})
	return {
		stage,
		attention,
		blocked,
		busy,
		actionable,
		showClaim,
		showFinish,
		retry,
		ownedByOther,
		switchTarget: ownedByOther ? (account?.canonical ?? null) : null,
		depositLegRecoverable,
		exitAttachable,
		isFuel,
		fuelRecovery,
		fuelRecoverable: fuelRecovery === "offer",
		showClaimWithoutFuel: fuel !== undefined && !isFuel && rec.completedAt === undefined && retry && actionable,
		claimedByOther,
	}
}
