/**
 * The claim card's words for the SDK's claim events and failures: each maps to the step, detail, attention and note the
 * card has always shown for the same moment. Pure: the engine applies what these return.
 */
import { type BridgeError, type DepositSearch, isBridgeError, type TransferEventBody } from "@unleashed/sdk"
import { isReceiptRecordMismatch } from "@unleashed/sdk/internal"
import { FEE_STOP_COPY } from "@/lib/fee-stop-copy"
import { humanizeWalletError } from "@/lib/wallet-errors"
import type { BridgeStep, RecordRuntime } from "./useBridgeJournal"

/** What one claim call has shown so far: the facts a later event's words depend on. */
export interface ClaimScene {
	/** The record passed its gates earlier this session: arrival is narrated as the quick re-check. */
	preGated: boolean
	/** This process sent the record's claim, so its landing is not narrated as a verification. */
	ownClaim: boolean
	registeredHere: boolean
	/** A checkpoint count was shown in this call: the next one never rises above it. */
	counted: boolean
	/** Which recovery of the deposit's facts is running: a failure there reads as that search or receipt read said. */
	recovering?: "searching" | "reading"
	/** The receipt read the last `claim-waiting` named, so a second event for it is its result. */
	lastPoll?: string
	landed?: "claim" | "claimed-elsewhere"
}

export const newScene = (preGated: boolean, ownClaim: boolean): ClaimScene => ({
	preGated,
	ownClaim,
	registeredHere: false,
	counted: false,
})

export interface Narration {
	step?: { step: BridgeStep; detail: string }
	runtime?: Partial<RecordRuntime>
}

const PROCESSING = "the claim is processing on Aztec"
const CONFIRM = "confirm in your Aztec wallet"
const RECOVERY_LINES = {
	searching: "looking for the deposit on Ethereum",
	reading: "checking the Ethereum deposit",
	waiting: "waiting for the Ethereum confirmation",
} as const

const step = (s: BridgeStep, detail: string): Narration => ({ step: { step: s, detail } })
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

type Arrival = Extract<TransferEventBody, { type: "arrival" }>

function narrateCount(e: Extract<Arrival, { stage: "counting" }>, scene: ClaimScene, rt: RecordRuntime | undefined): Narration {
	if (e.block !== undefined) {
		const blocks = e.blocksLeft ?? 0
		const counted = blocks > 0 ? step("syncing", `${plural(blocks, "block", "blocks")} until your funds arrive`) : {}
		return { ...counted, runtime: { syncBlock: e.block } }
	}
	const reported = e.checkpointsLeft
	if (reported === undefined) return {}
	// Passing the gate completes a count already shown; with none shown there is nothing to complete.
	if (reported === 0) return rt?.checkpointSpan ? { runtime: { checkpointsLeft: 0 } } : {}
	// The first reading of a call replaces the previous call's count in place, so the rail never drops to none.
	const prev = scene.counted ? rt : undefined
	scene.counted = true
	const left = Math.min(prev?.checkpointsLeft ?? reported, reported)
	return {
		...step("syncing", `${plural(left, "checkpoint", "checkpoints")} until your funds arrive`),
		runtime: { checkpointsLeft: left, checkpointSpan: prev?.checkpointSpan ?? left },
	}
}

function narrateArrival(e: Arrival, scene: ClaimScene, rt: RecordRuntime | undefined): Narration {
	if (scene.preGated) return step("sending", "checking the message")
	if (e.stage === "counting") return narrateCount(e, scene, rt)
	if (e.stage === "unfolded") return step("syncing", "waiting for the message to reach the L2")
	return step(
		"syncing",
		e.counted ? "message arrived — waiting for your wallet to sync it" : "waiting for your wallet to sync the message",
	)
}

function narrateReceipt(e: Extract<TransferEventBody, { type: "claim-waiting" }>, scene: ClaimScene): Narration {
	const read = `${e.txHash}:${e.poll}`
	if (read !== scene.lastPoll) {
		scene.lastPoll = read
		return step("confirming", PROCESSING)
	}
	return step("confirming", e.unreachable > 0 ? `node unreachable — retrying (${e.unreachable})` : PROCESSING)
}

function narrateVerifying(e: Extract<TransferEventBody, { type: "claim-verifying" }>, scene: ClaimScene): Narration {
	if (scene.ownClaim) return {}
	return step(
		"verifying",
		e.stage === "checking" ? "checking the claim against this record" : "confirmed on the node — waiting for your wallet to sync",
	)
}

function narrateLanding(e: Extract<TransferEventBody, { type: "claim-landed" }>, scene: ClaimScene): Narration {
	scene.landed = e.via
	return e.via === "claimed-elsewhere" ? { runtime: { attention: undefined, note: undefined, claimable: undefined } } : {}
}

/**
 * The card's narration of one claim event. `claimTxHash` is the record's stored claim hash: only that transaction's
 * proposed block lights the rail, never a gas claim sent after it.
 */
export function narrateClaim(
	e: TransferEventBody,
	scene: ClaimScene,
	rt: RecordRuntime | undefined,
	claimTxHash: string | undefined,
): Narration {
	switch (e.type) {
		case "deposit-recovery":
			scene.recovering = e.stage === "searching" ? "searching" : "reading"
			return step("depositing", RECOVERY_LINES[e.stage])
		case "deposit-confirmed":
			scene.recovering = undefined
			return { runtime: { attention: undefined, note: undefined } }
		case "arrival":
			return narrateArrival(e, scene, rt)
		case "claimable":
			return { runtime: { claimable: true } }
		case "registration-requested":
			return step("sending", CONFIRM)
		case "registration-sent":
			scene.registeredHere = true
			return step("sending", "registered — preparing the claim")
		case "claim-requested":
			return step("sending", e.leg === "token" && scene.registeredHere ? "confirm the claim in your Aztec wallet" : CONFIRM)
		case "claim-sent":
			scene.ownClaim = true
			return {}
		case "claim-waiting":
			return narrateReceipt(e, scene)
		case "claim-proposed":
			return e.txHash === claimTxHash && rt?.confirmLandedTxHash !== e.txHash ? { runtime: { confirmLandedTxHash: e.txHash } } : {}
		case "claim-verifying":
			return narrateVerifying(e, scene)
		case "claim-landed":
			return narrateLanding(e, scene)
		default:
			return {}
	}
}

const GAS_TAIL = "Your tokens are unaffected — retry the gas claim from this card."

/** The sentence a failure stands for: a fee stop's own copy, else the deepest cause's message, which is what the
 *  wallet or the chain said. */
export function failureText(e: unknown): string {
	if (isBridgeError(e) && e.code === "fee-stop" && e.stop) return FEE_STOP_COPY[e.stop]
	if (e instanceof Error && e.cause instanceof Error) return failureText(e.cause)
	return e instanceof Error ? e.message : String(e)
}

/** What a stopped claim leaves on the card. `run-failure` is today's catch-all: its text under the retry template. */
export type ClaimFailureView =
	| { kind: "card"; runtime: Partial<RecordRuntime>; clearRounds?: boolean }
	| { kind: "search"; search: DepositSearch }
	| { kind: "run-failure"; text: string }

const card = (runtime: Partial<RecordRuntime>, clearRounds?: boolean): ClaimFailureView => ({
	kind: "card",
	runtime,
	...(clearRounds ? { clearRounds } : {}),
})

const TAMPERED =
	"This record's message doesn't match its stored details — nothing was claimed. Restore the record from a backup, or discard it."
const GATE_TIMEOUT = "the L1→L2 message never became consumable — claim it again from the journal later"

/** A failed recovery of the deposit's facts. A search that failed found nothing it could vouch for; a receipt read reads
 *  as the receipt said it, with no retry template, terminal only when the receipt contradicts the record. */
function recoveryFailure(e: BridgeError, stage: "searching" | "reading"): ClaimFailureView {
	if (e.code === "deposit-not-found") return { kind: "search", search: e.search ?? "incomplete" }
	if (stage === "searching") return { kind: "search", search: "incomplete" }
	const raw = e.code === "deposit-reverted" ? FEE_STOP_COPY["deposit-reverted"] : failureText(e)
	return card({ attention: isReceiptRecordMismatch(raw) ? "receipt-mismatch" : "error", note: humanizeWalletError(raw) })
}

function codeFailure(e: BridgeError): ClaimFailureView {
	switch (e.code) {
		case "claim-dropped":
			return card({
				attention: "error",
				note: "The claim was dropped — claim again from this card. Nothing was lost.",
				confirmLandedTxHash: undefined,
			})
		case "claim-reverted":
			return card(
				{
					attention: "error",
					note: "The claim reverted on Aztec. You can retry from this card — the deposit remains claimable.",
					confirmLandedTxHash: undefined,
				},
				true,
			)
		case "message-invalid":
			return card({ attention: "tampered", note: TAMPERED })
		case "message-timeout":
			return { kind: "run-failure", text: e.cause instanceof Error ? failureText(e.cause) : GATE_TIMEOUT }
		default:
			return { kind: "run-failure", text: failureText(e) }
	}
}

/** The card after a claim call failed, for every failure the engine does not handle as control flow. */
export function claimFailure(e: unknown, scene: ClaimScene): ClaimFailureView {
	// Every failure after the tokens landed is the gas claim's.
	if (scene.landed) return card({ attention: "error", note: `${humanizeWalletError(failureText(e))}. ${GAS_TAIL}` })
	if (!isBridgeError(e)) return { kind: "run-failure", text: failureText(e) }
	if (scene.recovering) return recoveryFailure(e, scene.recovering)
	return codeFailure(e)
}

/** The card when a watching call reached the leftover gas claim, which needs the wallet. */
export const GAS_NEEDS_WALLET = `The gas claim needs your wallet. ${GAS_TAIL}`

/** A gas claim the landed tokens left that no retry can make: the record settles, saying why. */
export const gasLeftNote = (e: BridgeError): string => `${humanizeWalletError(failureText(e))}. ${GAS_TAIL}`
