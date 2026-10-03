import {
	type BridgeJournalRecord,
	type DepositJournalRecord,
	type SendDepositRecord,
	type WithdrawJournalRecord,
	assetKindOf,
	deriveSendDepositStage,
	isSendRecord,
} from "@unleashed/bridge-core"
import type { BridgeStep, RecordRuntime } from "@/composables/useBridgeJournal"
import { safeDisplay, safeSentence } from "@/lib/token-display"

/**
 * The ONE narration view-model: maps a record + its runtime onto the phase rail
 * BOTH surfaces render (stepper full, journal card compact). Phase STATES anchor on persisted
 * FACTS (the monotonic latch - a transiently cleared runtime step between engine rounds can
 * never regress a phase); the runtime only refines WHICH phase inside the fact-bounded zone is
 * active, its live detail, and its determinate progress.
 */

export type PhaseState = "pending" | "active" | "done" | "failed"

export interface BridgePhase {
	key: "permit" | "seal" | "approve" | "sign" | "deposit" | "sync" | "register" | "claim" | "confirm" | "exit" | "prove" | "finish"
	label: string
	state: PhaseState
	/** Live narration when active/failed (runtime detail or the phase's signing prompt). */
	detail?: string
	/** Determinate within-phase progress - ONLY where a real target exists (SYNC blocks, PROVE
	 *  blocks). Never fabricated: an honest ticking counter beats a fake bar. */
	progress?: { current: number; target: number; fraction: number }
	/** Deliberately OVERESTIMATED duration hint (queue psychology: beat the estimate, never miss it). */
	eta?: string
	/** The same hint in short form, on pending phases that wait on the chain rather than a signature. */
	estimate?: string
	/** Deposit CONFIRM quiet flip: the claim was seen in a PROPOSED block. The rail renders the
	 *  live phase in the done colour - display-only evidence, never a completion signal. */
	landed?: boolean
}

/** L2 blocks between the deposit-time snapshot and presumed message arrival (raven-style pacing). */
export const SYNC_TARGET_MARGIN_BLOCKS = 3

// Every attention fails the active phase: the rail is where the note + the fix-instruction live,
// so a mismatch or stale state never renders as a calm "active" prompt.
/** Attentions no retry can clear: the underlying fact is immutable (a foreign deployment binding, an
 *  L1 receipt that cannot supply the record's data), so EVERY surface must stop offering CLAIM/RETRY
 *  and stop narrating one. The journal-level Restore stays the recovery path. */
const TERMINAL_ATTENTIONS = new Set(["stale-deployment", "receipt-mismatch", "malformed-record"])

export function isTerminalAttention(attention?: string): boolean {
	return attention !== undefined && TERMINAL_ATTENTIONS.has(attention)
}

const FAILED_ATTENTIONS = new Set([
	"error",
	"unknown-outcome",
	"mismatch",
	"tampered",
	"unseal-failed",
	"stale",
	"stale-deployment",
	"receipt-mismatch",
	"malformed-record",
])

/** Every attention fails the record's live phase; the card reads the same set as "lost". */
export function isFailedAttention(attention?: string): boolean {
	return attention !== undefined && FAILED_ATTENTIONS.has(attention)
}

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n))

/** Every deposit shape the rail renders. A send's EXIT rail is the withdraw rail unchanged. */
type DepositRailRecord = DepositJournalRecord | SendDepositRecord

/** The record's rail. `wallet` names the user's Aztec wallet in the permission step's copy: a
 *  `walletLabel`, never a raw claimed name. */
export function stepperPhases(record: BridgeJournalRecord, runtime: RecordRuntime = {}, wallet = "your wallet"): BridgePhase[] {
	const phases =
		record.direction === "deposit" ? depositPhases(record, runtime, wallet) : withdrawPhases(record as WithdrawJournalRecord, runtime)
	return record.blocked === undefined ? phases : phases.map(failBlocked)
}

/** A persisted block fails the live phase with no runtime attention too: the record never runs
 *  again, so no later phase keeps an estimate. The card states the block's reason, so the phase it
 *  fails adds none. */
function failBlocked(phase: BridgePhase): BridgePhase {
	if (phase.state === "done") return phase
	return { key: phase.key, label: phase.label, state: phase.state === "active" ? "failed" : phase.state }
}

/** Where the whole run stands: done phases plus the live one's measured share, over every phase on
 *  the rail. Derived from the phases on each render and never smoothed, so a retry that returns to
 *  an earlier phase lowers it. */
export interface OverallProgress {
	/** 0..1; exactly 1 only when every phase is done. */
	fraction: number
	/** 1-based position of the live or failed phase; with none live, the count of done phases. */
	index: number
	total: number
	state: "running" | "failed" | "done"
}

/** A live phase never fills its own slot; only its completion does. */
const LIVE_SHARE_CAP = 0.99

export function overallProgress(phases: readonly BridgePhase[]): OverallProgress {
	const total = phases.length
	const done = phases.filter((p) => p.state === "done").length
	const live = phases.findIndex((p) => p.state === "active" || p.state === "failed")
	if (live === -1) {
		const complete = total > 0 && done === total
		return { fraction: complete ? 1 : 0, index: done, total, state: complete ? "done" : "running" }
	}
	const share = clamp01(Math.min(phases[live].progress?.fraction ?? 0, LIVE_SHARE_CAP))
	const state = phases[live].state === "failed" ? "failed" : "running"
	return { fraction: (done + share) / total, index: live + 1, total, state }
}

/** The session log's line for a step starting. A step starting is not its transaction landing, so
 *  no phrase claims anything was sent or confirmed. */
const LOG_PHRASE: Record<BridgeStep, string> = {
	granting: "asking your wallet to read {token}",
	sealing: "sealing the recovery secret on this device",
	signing: "signing the bridge intent",
	approving: "approving {token} for Permit2",
	depositing: "checking the deposit on Ethereum",
	exiting: "starting the exit on Aztec",
	unsealing: "unsealing the recovery secret",
	syncing: "waiting for Aztec to include it",
	sending: "claiming on Aztec",
	confirming: "waiting for the confirmation",
	verifying: "checking the record against the chain",
}

/** `{token}` is the symbol of the record's own token block; a record without one reads "this token"
 *  rather than guess, since a gas-only send approves the ERC-20 it pays with, not the Fee Juice it
 *  bridges. */
export function logPhrase(step: BridgeStep, rec?: BridgeJournalRecord): string {
	const symbol = rec && isSendRecord(rec) && rec.token ? safeDisplay(rec.token.displaySymbol) : "this token"
	return LOG_PHRASE[step].replace("{token}", () => symbol)
}

const phaseIf = (on: boolean, key: BridgePhase["key"]): BridgePhase["key"][] => (on ? [key] : [])

/** SYNC progress against the deposit-time snapshot + margin; without that snapshot, the checkpoints
 *  the arrival gate has counted down; empty when neither exists. */
function syncProgress(depositL2Block: number | undefined, rt: RecordRuntime): Partial<Record<string, BridgePhase["progress"]>> {
	const { syncBlock, checkpointsLeft, checkpointSpan } = rt
	if (depositL2Block !== undefined && syncBlock !== undefined) {
		const target = depositL2Block + SYNC_TARGET_MARGIN_BLOCKS
		const span = target - depositL2Block
		return { sync: { current: syncBlock, target, fraction: span > 0 ? clamp01((syncBlock - depositL2Block) / span) : 1 } }
	}
	if (checkpointsLeft === undefined || !checkpointSpan) return {}
	const current = Math.max(checkpointSpan - checkpointsLeft, 0)
	return { sync: { current, target: checkpointSpan, fraction: clamp01(current / checkpointSpan) } }
}

/** Which phase a deposit is at: the persisted stage first, live narration only to pick within a
 *  stage the facts leave ambiguous. */
function depositActiveKey(rec: DepositRailRecord, rt: RecordRuntime, registers: boolean): BridgePhase["key"] {
	const stage = deriveSendDepositStage(rec, { claimable: rt.claimable })
	if (stage === "done" || stage === "claiming") return "confirm"
	// A registration of its own is complete the moment its hash exists; the claim is what runs then.
	if (stage === "registering") return "claim"
	// On a first-time private token the next signature registers it; the claim follows on its own.
	const next = registers ? "register" : "claim"
	if (stage === "claimable") return next
	if (stage === "syncing") return rt.step === "unsealing" || rt.step === "sending" ? next : "sync"
	return preDepositKey(rec, rt)
}

/** Nothing has crossed yet: the run is at its FIRST prompt, never at a DEPOSIT that never happened. */
function preDepositKey(rec: DepositRailRecord, rt: RecordRuntime): BridgePhase["key"] {
	if (rec.depositTxHash) return "deposit"
	if (rt.step === "granting") return "permit"
	if (rt.step === "sealing") return "seal"
	if (rt.step === "signing") return "sign"
	if (rt.step === "approving") return "approve"
	if (rt.step === "depositing") return "deposit"
	return rec.isPrivate ? "seal" : "sign"
}

/** What the claim's confirmation does, by what rides in that one transaction. */
const UNSEAL_PROMPT = "Sign in your Ethereum wallet to unseal the recovery secret, then confirm in your Aztec wallet."

function claimPromptOf(fueled: boolean, registersInClaim: boolean): string {
	if (registersInClaim) {
		return fueled
			? "Confirm in your Aztec wallet — one transaction registers the token, then claims your tokens and your gas."
			: "Confirm in your Aztec wallet — one transaction registers the token and claims it."
	}
	return fueled
		? "Confirm in your Aztec wallet — one transaction claims your tokens and your gas."
		: "Confirm the claim in your Aztec wallet."
}

function depositCopy(
	rec: DepositRailRecord,
	rt: RecordRuntime,
	shape: { gasOnly: boolean; fueled: boolean; registersInClaim: boolean },
	wallet: string,
) {
	const { gasOnly, fueled, registersInClaim } = shape
	const symbol = isSendRecord(rec) && rec.token ? safeDisplay(rec.token.displaySymbol) : "this token"
	const labels: Record<string, string> = {
		permit: "Permission",
		seal: "Seal",
		approve: "Approve",
		sign: "Authorize",
		deposit: fueled ? "Deposit + fuel" : "Deposit",
		sync: "Crossing",
		register: "Register",
		claim: gasOnly ? "Claim gas" : registersInClaim ? "Register + claim" : "Claim",
		confirm: "Confirm",
	}
	const claimPrompt = claimPromptOf(fueled, registersInClaim)
	const prompts: Record<string, string> = {
		permit: `Allow reading ${symbol} state in ${wallet}.`,
		seal: "Sign in your Ethereum wallet — encrypts this bridge's recovery secret. No funds move.",
		approve: "First time only: approve Permit2 for this token in your Ethereum wallet. No funds move yet.",
		sign: fueled
			? "Sign the bridge intent in your Ethereum wallet — one signature covers the swap and the deposit."
			: "Sign the bridge intent in your Ethereum wallet — one signature authorizes the deposit.",
		deposit: rec.depositTxHash
			? "Waiting for the Ethereum confirmation…"
			: fueled
				? "Confirm the deposit in your Ethereum wallet — the fuel swap rides along in the same transaction."
				: "Confirm the deposit in your Ethereum wallet.",
		sync: "Aztec picks up deposits every few blocks. Nothing for you to do.",
		register:
			rt.step === "unsealing"
				? UNSEAL_PROMPT
				: "Confirm in your Aztec wallet — this first bridge registers the token; the claim follows on its own.",
		claim: rt.step === "unsealing" ? UNSEAL_PROMPT : claimPrompt,
		confirm: "Confirming on Aztec — no signature needed.",
	}
	const etas: Partial<Record<string, string>> = {
		permit: `your confirmation in ${wallet}`,
		sign: "your signature — instant",
		deposit: "usually under 1 min",
		sync: "usually 1-4 min",
		register: "your signature + a few sec",
		claim: rec.isPrivate && isSendRecord(rec) && rec.registerTxHash ? "a moment, then your signature" : "your signature + a few sec",
		confirm: "usually 1-2 min",
	}
	return { labels, prompts, etas }
}

/**
 * The deposit rail, one shape for every deposit record. A send that registers the token says so on
 * its record: a PRIVATE one registers in a transaction of its own, so REGISTER is a phase ahead of
 * CLAIM; a public one registers inside the claim, so CLAIM is relabeled REGISTER + CLAIM. PERMISSION
 * renders only when the wallet's token grant is part of THIS run (being asked now, or granted
 * earlier in the run), and APPROVE only when an approval is: the flows check both silently, so a
 * run that needs neither never sees a step it does not need, and after a reload the ephemeral
 * outcome is gone and the step is simply not shown — honest, because a retry re-checks
 * idempotently.
 */
function depositPhases(rec: DepositRailRecord, rt: RecordRuntime, wallet: string): BridgePhase[] {
	// A gas-only bridge carries Fee Juice, not a token; a fueled one swaps INSIDE the deposit
	// transaction, so there is no separate FUEL phase to flip — DEPOSIT is relabeled instead.
	const gasOnly = assetKindOf(rec) === "fee-juice"
	// A gas slice is DECLARED by a send's intent and EVIDENCED by an older record's fuel block.
	const fueled = !gasOnly && (rec.fuel !== undefined || (isSendRecord(rec) && rec.intent === "token+gas"))
	const registering = isSendRecord(rec) && (rec.registers === true || rec.registerTxHash !== undefined)
	const registers = rec.isPrivate && registering
	const keys: BridgePhase["key"][] = [
		...phaseIf(rt.step === "granting" || rt.grantOutcome === "done", "permit"),
		...phaseIf(rec.isPrivate, "seal"),
		...phaseIf(rt.step === "approving" || rt.approveOutcome === "done", "approve"),
		"sign",
		"deposit",
		"sync",
		...phaseIf(registers, "register"),
		"claim",
		"confirm",
	]
	const activeKey = depositActiveKey(rec, rt, registers)
	const { labels, prompts, etas } = depositCopy(rec, rt, { gasOnly, fueled, registersInClaim: registering && !rec.isPrivate }, wallet)
	const progress = activeKey === "sync" ? syncProgress(rec.depositL2Block, rt) : {}
	// Hash-scoped: light only for the record's CURRENT claim tx, so a dropped/replaced claim can
	// never inherit a previous attempt's mint dot (any tab).
	const landedConfirm = rt.confirmLandedTxHash !== undefined && rt.confirmLandedTxHash === rec.claimTxHash
	const completed = rec.completedAt !== undefined
	return buildPhases(keys, labels, prompts, etas, DEPOSIT_ESTIMATES, progress, activeKey, completed, rt, landedConfirm)
}

function withdrawPhases(rec: WithdrawJournalRecord, rt: RecordRuntime): BridgePhase[] {
	const keys: BridgePhase["key"][] = ["exit", "prove", "finish", "confirm"]

	const proven = rt.proven === true || (rt.provenBlock !== undefined && rt.targetBlock !== undefined && rt.provenBlock >= rt.targetBlock)
	let activeKey: BridgePhase["key"]
	if (rec.consumeTxHash) activeKey = "confirm"
	else if (rec.exitTxHash) activeKey = proven ? "finish" : "prove"
	else activeKey = "exit"

	const labels: Record<string, string> = { exit: "Exit", prove: "Prove", finish: "Finish", confirm: "Confirm" }
	const proveDetail =
		rt.provenBlock !== undefined && rt.targetBlock !== undefined
			? `Proven block ${rt.provenBlock} of ${rt.targetBlock} — lands in epoch batches.`
			: "Waiting for Aztec to prove the exit — lands in epoch batches."
	const prompts: Record<string, string> = {
		exit: rec.isPrivate
			? "Confirm the exit in your Aztec wallet (one signature)."
			: "Confirm in your Aztec wallet — two signatures: the authorization, then the exit.",
		prove: proveDetail,
		finish: "Confirm in your Ethereum wallet to release the funds.",
		confirm: "Waiting for the Ethereum confirmation…",
	}
	const etas: Partial<Record<string, string>> = {
		exit: "your signatures + a few sec",
		prove: "tens of minutes — epoch batches",
		finish: "your signature + ~1 min",
		confirm: "usually under 2 min",
	}

	const progress = activeKey === "prove" ? proveProgress(rt) : {}
	return buildPhases(keys, labels, prompts, etas, WITHDRAW_ESTIMATES, progress, activeKey, rec.completedAt !== undefined, rt)
}

/** PROVE progress from the proven-block counts the engine streams. The counts are absolute block
 *  numbers, so the share runs from the first proven block seen, never from block 0. */
function proveProgress(rt: RecordRuntime): Partial<Record<string, BridgePhase["progress"]>> {
	const { provenBlock, targetBlock, provenFrom } = rt
	if (provenBlock === undefined || targetBlock === undefined || provenFrom === undefined || targetBlock <= provenFrom) return {}
	return {
		prove: { current: provenBlock, target: targetBlock, fraction: clamp01((provenBlock - provenFrom) / (targetBlock - provenFrom)) },
	}
}

type Estimates = Partial<Record<BridgePhase["key"], string>>

/** Pending phases that wait on the chain; a phase that waits on the user's signature gets none. */
const DEPOSIT_ESTIMATES: Estimates = { deposit: "~1 min", sync: "~1–4 min", confirm: "~1–2 min" }
const WITHDRAW_ESTIMATES: Estimates = { prove: "tens of min", confirm: "~2 min" }

function buildPhases(
	keys: BridgePhase["key"][],
	labels: Record<string, string>,
	prompts: Record<string, string>,
	etas: Partial<Record<string, string>>,
	estimates: Estimates,
	progress: Partial<Record<string, BridgePhase["progress"]>>,
	activeKey: BridgePhase["key"],
	completed: boolean,
	rt: RecordRuntime,
	/** Deposit-only: the withdraw CONFIRM is an L1 wait and never lights the quiet flip. */
	landedConfirm?: boolean,
): BridgePhase[] {
	const activeIndex = keys.indexOf(activeKey)
	const failed = isFailedAttention(rt.attention)
	return keys.map((key, i) => {
		if (completed) return { key, label: labels[key], state: "done" as const }
		if (i < activeIndex) return { key, label: labels[key], state: "done" as const }
		if (i === activeIndex) return activePhase(key, { labels, prompts, etas, progress, rt, failed, landedConfirm })
		// A failed run is going nowhere until the user acts: no pending phase promises a duration.
		const estimate = failed ? undefined : estimates[key]
		return { key, label: labels[key], state: "pending" as const, ...(estimate ? { estimate } : {}) }
	})
}

function activePhase(
	key: BridgePhase["key"],
	ctx: {
		labels: Record<string, string>
		prompts: Record<string, string>
		etas: Partial<Record<string, string>>
		progress: Partial<Record<string, BridgePhase["progress"]>>
		rt: RecordRuntime
		failed: boolean
		landedConfirm?: boolean
	},
): BridgePhase {
	const { labels, prompts, etas, progress, rt, failed, landedConfirm } = ctx
	return {
		key,
		label: labels[key],
		state: failed ? ("failed" as const) : ("active" as const),
		// Notes and step details can carry wallet or RPC text: stripped of bidi controls and capped.
		detail: failed ? rt.note && safeSentence(rt.note) : rt.stepDetail !== undefined ? safeSentence(rt.stepDetail) : prompts[key],
		progress: progress[key],
		eta: failed ? undefined : etas[key],
		...(key === "confirm" && landedConfirm && !failed ? { landed: true } : {}),
	}
}
