import {
	type AnyJournalRecord,
	type BridgeJournalRecord,
	type CrossChainDepositRecord,
	type DepositEnvelopeV2,
	type EncryptionKey,
	type DepositJournalRecord,
	type KV,
	type SendDepositRecord,
	type SendJournalRecord,
	type SendWithdrawRecord,
	type WithdrawJournalRecord,
	JOURNAL_KEY_PREFIX,
	assetKindOf,
	envelopeMatchesRecord,
	envelopeV3MatchesRecord,
	isCrossChainRecord,
	loadAllRecords,
	loadCrossChainJournal,
	loadJournal,
	RecordDeltaRefused,
	claimView,
	openDepositEnvelope,
	openDepositEnvelopeV3,
	patchRecord as journalPatch,
	patchRecordDelta,
	patchRecordWhen as journalPatchWhen,
	pruneCompleted,
	quarantineInvalid,
	recoveryKeyFromSignature,
	recoveryKeyMessage,
	rekeyRecord,
	rekeyRecordWhen,
	removeRecord,
	resealExactEnvelope,
	revokeSealTrust,
	sameClaimIdentity,
	insertRecord,
	upsertRecord,
} from "@unleashed/bridge-core"
import { Fr } from "@aztec-labs/aztec.js/fields"
import {
	type BridgeError,
	type DepositRecord,
	type DepositSearch,
	type DepositSecrets,
	type JournalTokenBlock,
	type Network,
	type Reads,
	type TransferEvent,
	claimRetired,
	isBridgeError,
} from "@unleashed/sdk"
import type { AztecSigner, ClaimOptions, ClaimOutcome } from "@unleashed/sdk/fuel"
import { isWellFormedTxHash } from "@unleashed/sdk/internal"
import { feeJuiceAddress, predictPortal } from "@unleashed/sdk/protocol"
import type { GrantOutcome } from "@/lib/send-model"
import { NETWORK } from "@/lib/network"
import { computed, ref, watch } from "vue"
import { FUEL_PORTAL } from "@/contracts/bridge-generation"
import { SYNC_TARGET_MARGIN_BLOCKS, stepLogLines } from "@/lib/bridge-steps"
import { crossChainLogFacts } from "@/lib/crosschain-steps"
import { trimTxHash } from "@/lib/format"
import { humanizeWalletError, isUserRejection } from "@/lib/wallet-errors"
import { FEE_STOP_COPY } from "@/lib/fee-stop-copy"
import { type ClaimScene, GAS_NEEDS_WALLET, claimFailure, failureText, gasLeftNote, narrateClaim, newScene } from "./claim-narration"
import { HELD_ELSEWHERE, type JournalLocks } from "@/lib/journal-locks"
import type { ExitSearch } from "./exit-attach"
import { type DisplayAmount, displayAmountOf } from "@/lib/asset-label"
import { dropPhaseClock } from "@/lib/phase-clock"
import { safeAddressText, safeSentence } from "@/lib/token-display"
import { withOperation } from "./useOpsInFlight"

// Verbose tracing while the bridge flows are being hardened - ids, stages, tx hashes ONLY.
// Secrets, envelopes, signatures, and keys must never reach this log.
const log = (...args: unknown[]) => console.log("[bridge:journal]", ...args)

const PRUNE_AFTER_MS = 7 * 24 * 60 * 60 * 1000
export { SYNC_TARGET_MARGIN_BLOCKS }

/** Every deposit record the claim path drives. The shared helpers read only the facts both
 *  shapes carry; the steps that differ re-narrow with `runsAsSend`. */
export type ClaimRecord = DepositJournalRecord | SendDepositRecord

/** A record the send lanes run: an Ethereum-origin send, or a cross-chain deposit, which keeps every
 *  schema-3 deposit fact and adds only `route`. */
function runsAsSend(rec: { schema: number }): rec is SendJournalRecord {
	return rec.schema === 3 || rec.schema === 4
}

export type Attention =
	| "mismatch"
	| "tampered"
	| "unseal-failed"
	| "stale"
	| "stale-deployment"
	/** Terminal: the L1 receipt can't supply this record's fuel data. Retrying repeats the same
	 *  immutable failure, so the card must not offer one — only a restore recovers it. */
	| "receipt-mismatch"
	/** Terminal: the persisted claim hash cannot be asked about (corrupted or hand-edited
	 *  storage). A retry re-reads the same record; only a restore or a discard changes it. */
	| "malformed-record"
	| "unknown-outcome"
	| "error"

/** The live narration of what is happening RIGHT NOW for a record - engine steps plus the flows'
 *  L1/L2 legs. Ephemeral display state only - never persisted, never an input to completion logic. */
export type BridgeStep =
	| "granting"
	| "sealing"
	| "signing"
	| "approving"
	| "depositing"
	| "exiting"
	| "unsealing"
	| "syncing"
	| "sending"
	| "confirming"
	| "verifying"
	// A cross-chain send's source leg and its rail's crossing to Ethereum.
	| "preparing-source"
	| "approving-source"
	| "sending-source"
	| "bridging"
	| "bridging-late"

export interface RecordRuntime {
	busy?: boolean
	attention?: Attention
	/** Human-readable detail for the attention state. */
	note?: string
	/** Live narration: the current step + a free-text detail (poll counts etc.). */
	step?: BridgeStep
	stepDetail?: string
	/** Set when a real APPROVE tx completed in THIS session - keeps the step visible as done for the
	 *  rest of the run. A sufficient allowance never sets it (the step is simply not rendered), and it
	 *  is absent after a reload - a retry re-checks the allowance idempotently. */
	approveOutcome?: "done"
	/** The wallet's token permission was raised and granted in THIS run — display-only, like `approveOutcome`. */
	grantOutcome?: "done"
	/** Withdraw proving countdown inputs. */
	provenBlock?: number
	targetBlock?: number
	/** The first proven block seen once `targetBlock` was known. Both counts are absolute L2 block
	 *  numbers, so PROVE's progress is measured from here rather than from block 0. */
	provenFrom?: number
	/** Deposit: the record's message is presumed consumable (leafIndex known). */
	claimable?: boolean
	proven?: boolean
	/** Current L2 block during the sync countdown - feeds the SYNC progress bar. */
	syncBlock?: number
	/** The fewest checkpoints left the gate has read this attempt: SYNC's progress when there is no
	 *  block snapshot. Display-only; the gate alone decides arrival. */
	checkpointsLeft?: number
	/** `checkpointsLeft` when this attempt's wait began: its denominator. */
	checkpointSpan?: number
	/** Deposit CONFIRM quiet flip: the receipt poll saw THIS claim tx in a PROPOSED block. Display-
	 *  only evidence (the rail's dot goes mint) - NEVER settlement-grade. Hash-scoped on purpose:
	 *  the view lights only while it equals the record's CURRENT claimTxHash, so a dropped/replaced
	 *  claim (any tab) can never inherit a previous claim's mint dot. */
	confirmLandedTxHash?: string
	/** When discovery last finished reading the chains for a cross-chain record (ms). Display-only. */
	checkedAt?: number
	/** What this tab saw happen to the record, oldest first: a fixed phrase per step change and a row
	 *  per transaction hash that appeared. Never a note, a step detail or an error; never persisted,
	 *  so a page reload starts it empty. */
	log?: readonly LogRow[]
}

export interface LogRow {
	/** Unique per row in this tab: the render key, so a sliding window moves rows rather than rewriting
	 *  them (a `role="log"` region announces rewritten text again). */
	seq: number
	/** Epoch ms. */
	at: number
	text: string
}

/** The claim material the engine resolved: the record's claim value, plus the unsealed envelope of
 *  a private record (its authoritative copy of the deposit's facts). */
export type ClaimMaterial = { secretHex: string; envelope?: DepositEnvelopeV2 }

/** One of the SDK's claim entries: `claimToken`, or `claimFuel` for gas. */
export type ClaimEntry = (net: Network, r: Reads, aztec: AztecSigner, rec: DepositRecord, run: ClaimOptions) => Promise<ClaimOutcome>

/** What a claim runs with: the session's reads and Aztec signer, and the SDK's checked network (a failed check is
 *  not remembered, so the next call reads again). */
export interface ClaimContext {
	reads: Reads
	aztec: AztecSigner
	network: () => Promise<Network>
}

/**
 * Chain/wallet boundaries injected so the engine is unit-testable with plain fakes. Production
 * wiring lives in the composables that own the real clients (useSend / useHubExit) and passes these
 * once at startup via `connectJournalDeps`.
 */
export interface JournalEngineDeps {
	kv: KV
	now: () => number
	/** Sign an EIP-191 message with the CONNECTED L1 account (used to re-derive seal keys). */
	signL1?: (message: string) => Promise<string>
	connectedL1?: () => string | null
	connectedAztec?: () => string | null
	/** Drive a withdraw record's proven-wait → witness → L1 consume. Returns the consume tx hash.
	 *  onProgress streams { provenBlock, targetBlock } for the countdown. */
	consume?: (
		rec: WithdrawJournalRecord,
		onProgress: (p: { provenBlock?: number; targetBlock?: number }) => void,
	) => Promise<{ consumeTxHash: string }>
	/** Wait for an already-submitted consume tx; true = success. */
	waitConsumeReceipt?: (txHash: string) => Promise<boolean>
	/** Verify a rediscovered consume tx actually consumes THIS record's exit (identity check). */
	verifyConsumeIdentity?: (rec: WithdrawJournalRecord, txHash: string) => Promise<boolean>
	/** The generation every schema-3 record must belong to. Absent ⇒ this network has no send
	 *  lane, and no send record can be resumed on it. */
	sendBinding?: () => { factory: string; implementation: string; hub: string; feeJuicePortal: string } | undefined
	/** Re-read the factory's frozen registration and compare the WHOLE token block against it.
	 *  `null` ⇒ the block still matches; a string is the user-facing reason it does not, and is
	 *  persisted as `blocked` — the record is never silently corrected. */
	validateTokenBlock?: (token: JournalTokenBlock) => Promise<string | null>
	/** The per-token wallet grant. A schema-3 lane runs only on "granted". */
	ensureTokenGrant?: (token: JournalTokenBlock) => Promise<GrantOutcome>
	/** A schema-3 exit's L1 tail: the consume runs against the record's OWN portal clone, so it
	 *  cannot share the single-portal dep above. */
	consumeSend?: (
		rec: SendWithdrawRecord,
		onProgress: (p: { provenBlock?: number; targetBlock?: number }) => void,
	) => Promise<{ consumeTxHash: string }>
	/** The identity check for a rediscovered schema-3 consume tx (its `to` is the token's clone). */
	verifyConsumeIdentitySend?: (rec: SendWithdrawRecord, txHash: string) => Promise<boolean>
	/** Re-pin the wallet's grant set from the tokens the journal still holds. Called whenever a
	 *  record leaves, so a pin never outlives the record that earned it. */
	retainPinnedTokens?: (needed: string[]) => void
	/** Find (and re-read) the exit transaction of a send exit that never recorded its hash: the one
	 *  transaction in the window whose FIRST L2→L1 message is the record's, excluding `taken` (every
	 *  hash and id the journal already holds). Absent ⇒ the record keeps today's note. */
	findExitTx?: (rec: SendWithdrawRecord, taken: ReadonlySet<string>) => Promise<ExitSearch>
	/** The SDK's claim entries (tests pass fakes). */
	claimEntries?: { token: ClaimEntry; fuel: ClaimEntry }
	/** What a claim runs with. Throws without a connected Aztec wallet unless `watchOnly`, which never prompts. */
	claimContext?: (opts: { recipient: string; watchOnly: boolean }) => Promise<ClaimContext>
	/** The card's "Claim without fuel" choice for this record. */
	withoutGas?: (id: string) => boolean
	/** The cross-tab locks: a record's runner and the guarded journal writes. Absent ⇒ process-local
	 *  dedup and synchronous best-effort writes, as before. */
	locks?: JournalLocks
	/** Injectable wait (tests pass a no-op; production uses real timers). */
	waitMs?: (ms: number) => Promise<void>
}

const records = ref<BridgeJournalRecord[]>([])
/** Schema-4 records, from their own storage key. */
const crossChainRecords = ref<CrossChainDepositRecord[]>([])
const runtime = ref<Record<string, RecordRuntime>>({})

/** Every record the engine runs, both keys. A cross-chain record enters the send lanes as the schema-3
 *  shape it extends (`runsAsSend`); its own `route` facts are written only through the cross-chain helpers. */
function engineRecords(): BridgeJournalRecord[] {
	return [...records.value, ...(crossChainRecords.value as unknown as BridgeJournalRecord[])]
}

// Module state, deliberately non-reactive: secrets and locks never enter Vue reactivity.
const sessionLive = new Set<string>()
/** Discarded here, its storage removal waiting for the journal lock. */
const discarding = new Set<string>()
const inFlight = new Set<string>()
const secretCache = new Map<string, { secretHex: string; envelope: DepositEnvelopeV2 }>()
// Set ONLY when THIS process sent the record's claim: its landing is not narrated as a
// verification. Deliberately NOT sessionLive.
const localClaimProvenance = new Set<string>()
// Per-record generation token - every fresh runner entry and every discard bumps it, so a
// chunked receipt round scheduled before the bump exits silently instead of racing the new owner.
const generations = new Map<string, number>()
// Cumulative exhausted receipt rounds per record (caps the ~30-min soft wait).
const receiptRounds = new Map<string, number>()

function bumpGen(id: string): number {
	const next = (generations.get(id) ?? 0) + 1
	generations.set(id, next)
	const call = activeCalls.get(id)
	if (call) stopCall(call, "generation")
	return next
}
function genOf(id: string): number {
	return generations.get(id) ?? 0
}
// One promptful action per wallet lane at a time; acquired per INDIVIDUAL prompt, never held
// across the other lane's await (the ABBA rule).
const lanes: Record<"l1" | "aztec", Promise<void>> = { l1: Promise.resolve(), aztec: Promise.resolve() }

let deps: JournalEngineDeps = { kv: typeof localStorage === "undefined" ? memoryKV() : localStorage, now: Date.now }
let initialized = false

function memoryKV(): KV {
	const store = new Map<string, string>()
	return {
		getItem: (k) => store.get(k) ?? null,
		setItem: (k, v) => void store.set(k, v),
		removeItem: (k) => void store.delete(k),
	}
}

export function runOnLane<T>(lane: "l1" | "aztec", fn: () => Promise<T>): Promise<T> {
	const result = lanes[lane].then(fn)
	lanes[lane] = result.then(
		() => undefined,
		() => undefined,
	)
	return result
}

function reload(): void {
	const kept = <T extends { id: string }>(rs: T[]) => (discarding.size ? rs.filter((r) => !discarding.has(r.id)) : rs)
	records.value = kept(loadJournal(deps.kv))
	crossChainRecords.value = kept(loadCrossChainJournal(deps.kv))
	logNewHashes()
}

function setRuntime(id: string, patch: RecordRuntime): void {
	// A raised attention ends the log's stretch: the retry that follows narrates its steps afresh.
	if (patch.attention !== undefined) loggedSteps.delete(id)
	runtime.value = { ...runtime.value, [id]: { ...runtime.value[id], ...patch } }
}

const LOG_CAP = 50
const TX_HASH = /^0x[0-9a-f]{64}$/i
const HASH_LEGS = [
	["depositTxHash", "Deposit"],
	["approveTxHash", "Approval"],
	["registerTxHash", "Registration"],
	["claimTxHash", "Claim"],
	["exitTxHash", "Exit"],
	["consumeTxHash", "Finish"],
] as const
type HashLeg = (typeof HASH_LEGS)[number][0]

/** Per logged record, the `leg:hash` pairs already accounted for: seeded when its log starts, so only
 *  a hash that appears afterwards is logged, once, whichever reload sees it first (another tab's
 *  write, or one that lands between a re-key's write and its runtime hand-over). A hash cleared and
 *  later restored with the same value is not logged again. */
const loggedHashes = new Map<string, Set<string>>()
/** Per logged record, the steps phrased since its last hash row or attention. A runner ends by
 *  clearing its step and a poll can alternate two steps, so a change against the runtime's current
 *  step would repeat rows every round. */
const loggedSteps = new Map<string, Set<BridgeStep>>()
let logSeq = 0

/** The rows a record's facts earn, once per key: a cross-chain send's proven legs in its own words,
 *  every other transaction hash as merely observed. */
function observedRows(rec: AnyJournalRecord | undefined): { key: string; lines: string[] }[] {
	if (!rec) return []
	const cross = isCrossChainRecord(rec)
	const fields: Partial<Record<HashLeg, unknown>> = rec
	const legs = HASH_LEGS.flatMap(([leg, name]) => {
		const hash = fields[leg]
		// A cross-chain deposit and source approval come from proven events, and their own rows say so.
		if ((cross && (leg === "depositTxHash" || leg === "approveTxHash")) || typeof hash !== "string" || !TX_HASH.test(hash)) return []
		// Observed, never "sent" or "confirmed": another tab's write reaches this through the same reload.
		return [{ key: `${leg}:${hash.toLowerCase()}`, lines: [`${name} hash observed · ${trimTxHash(safeAddressText(hash))}`] }]
	})
	return cross ? [...crossChainLogFacts(rec), ...legs] : legs
}

/** The runtime patch appending `texts` to a record's log; a log that starts here seeds its seen hashes. */
function logPatch(id: string, ...texts: string[]): Pick<RecordRuntime, "log"> {
	const rows = runtime.value[id]?.log
	if (!rows) loggedHashes.set(id, new Set(observedRows(engineRecords().find((r) => r.id === id)).map((h) => h.key)))
	const added = texts.map((text) => {
		logSeq += 1
		return { seq: logSeq, at: deps.now(), text }
	})
	return { log: [...(rows ?? []), ...added].slice(-LOG_CAP) }
}

/** Appends a row the caller saw proven, such as a source-chain approval's successful receipt; never a
 *  note or an error. */
export function logRecordLine(id: string, text: string): void {
	loggedSteps.delete(id)
	setRuntime(id, logPatch(id, text))
}

function moveEntry<T>(map: Map<string, T>, from: string, to: string): void {
	const value = map.get(from)
	map.delete(from)
	if (value !== undefined && !map.has(to)) map.set(to, value)
}

function stepLogPatch(id: string, step: BridgeStep): Partial<Pick<RecordRuntime, "log">> {
	const seen = (runtime.value[id]?.log && loggedSteps.get(id)) || new Set<BridgeStep>()
	if (seen.has(step)) return {}
	loggedSteps.set(id, seen.add(step))
	const rec = engineRecords().find((r) => r.id === id)
	return logPatch(id, ...stepLogLines(step, rec))
}

function logNewHashes(): void {
	for (const rec of engineRecords()) {
		const seen = runtime.value[rec.id]?.log ? loggedHashes.get(rec.id) : undefined
		if (!seen) continue
		for (const { key, lines } of observedRows(rec)) {
			if (seen.has(key)) continue
			seen.add(key)
			loggedSteps.delete(rec.id)
			setRuntime(rec.id, logPatch(rec.id, ...lines))
		}
	}
}

function patchRecord(id: string, patch: Partial<BridgeJournalRecord>): void {
	journalPatch(deps.kv, id, patch)
	reload()
}

/** Wire the real chain deps (and re-wire freely - tests inject fakes). */
export function connectJournalDeps(next: Partial<JournalEngineDeps>): void {
	deps = { ...deps, ...next }
}

export function initJournal(): void {
	if (initialized) return
	initialized = true
	// BEFORE anything writes: every write round-trips the journal through its validator, so a row
	// that fails it would be dropped for good by the first patch instead of being kept for inspection.
	const quarantined = quarantineInvalid(deps.kv)
	if (quarantined > 0) log("quarantined unreadable journal entries", { quarantined })
	pruneCompleted(deps.kv, PRUNE_AFTER_MS, deps.now())
	reload()
	if (typeof window !== "undefined") {
		// Another tab wrote the journal - rehydrate; per-record merge writes make this loss-free.
		window.addEventListener("storage", (e) => {
			if (e.key === null || e.key.startsWith(JOURNAL_KEY_PREFIX)) reload()
		})
	}
	log("journal initialized", { records: records.value.length })
}

/** TEST-ONLY: reset module state between cases. */
export function __resetJournalForTests(): void {
	initialized = false
	records.value = []
	crossChainRecords.value = []
	runtime.value = {}
	sessionLive.clear()
	discarding.clear()
	inFlight.clear()
	secretCache.clear()
	localClaimProvenance.clear()
	generations.clear()
	receiptRounds.clear()
	loggedHashes.clear()
	loggedSteps.clear()
	lastCompleted.value = null
	activeFlowId.value = null
	lanes.l1 = Promise.resolve()
	lanes.aztec = Promise.resolve()
	deps = { kv: memoryKV(), now: Date.now }
}

export function markSessionLive(id: string): void {
	sessionLive.add(id)
}
export function isSessionLive(id: string): boolean {
	return sessionLive.has(id)
}
export function cacheSecret(id: string, secretHex: string, envelope: DepositEnvelopeV2): void {
	secretCache.set(id, { secretHex, envelope })
}
export function forgetClaimMaterial(id: string): void {
	secretCache.delete(id)
}

/** The cached claim material, unless the cross-chain record's deposit moved since it was cached: discovery
 *  re-derives those facts (here or in another tab), and material for another leaf claims a message that is
 *  not there. */
function cachedMaterial(rec: ClaimRecord): { secretHex: string; envelope: DepositEnvelopeV2 } | undefined {
	const cached = secretCache.get(rec.id)
	if (!cached || !isCrossChainRecord(rec as AnyJournalRecord) || envelopeMatchesRecord(cached.envelope, rec)) return cached
	secretCache.delete(rec.id)
	return undefined
}

export function addRecord(rec: BridgeJournalRecord): void {
	upsertRecord(deps.kv, rec)
	reload()
}

/** Why a deposit stops before anything is signed: its record could not be stored and read back. */
export const RECORD_NOT_PERSISTED = "Could not persist the bridge record — aborting before the deposit (storage full?)."

/** Write-and-verify, insert-only: a deposit's record must be durably stored BEFORE the irreversible
 *  L1 tx - a storage failure here throws and aborts the flow instead of proceeding into stranding.
 *  `false`, writing nothing, when a record already holds the id: claim material is never replaced. */
export function addRecordVerified(rec: BridgeJournalRecord): boolean {
	if (!insertRecord(deps.kv, rec)) return false
	if (!loadJournal(deps.kv).some((r) => r.id === rec.id)) throw new Error(RECORD_NOT_PERSISTED)
	reload()
	return true
}

export function updateRecord(id: string, patch: Partial<BridgeJournalRecord>): void {
	patchRecord(id, patch)
}

/** `updateRecord` guarded by a predicate over the freshly loaded record, the patch computed from
 *  that same load: guard, merge and write in one synchronous span. Undefined when the id is gone
 *  or the guard rejects. */
export function updateRecordWhen(
	id: string,
	when: (current: BridgeJournalRecord) => boolean,
	patch: Partial<BridgeJournalRecord> | ((current: BridgeJournalRecord) => Partial<BridgeJournalRecord>),
): BridgeJournalRecord | undefined {
	const written = journalPatchWhen(deps.kv, id, when, patch)
	reload()
	return written
}

/** The PERSISTED record, read straight from kv — not this tab's reactive copy, which lags other
 *  tabs' writes until their storage event lands. For read-then-patch sites; touches no ref. */
export function currentRecord(id: string): BridgeJournalRecord | undefined {
	if (discarding.has(id)) return undefined
	return loadAllRecords(deps.kv).find((r) => r.id === id) as BridgeJournalRecord | undefined
}

/** Journal first for a cross-chain deposit: inserted under its own key and read back before any
 *  source-chain signature, so a failed write aborts instead of stranding the claim material.
 *  `false`, writing nothing, when a record already holds the id. */
export function addCrossChainRecordVerified(rec: CrossChainDepositRecord): boolean {
	if (!insertRecord(deps.kv, rec)) return false
	if (!loadCrossChainJournal(deps.kv).some((r) => r.id === rec.id)) throw new Error(RECORD_NOT_PERSISTED)
	reload()
	return true
}

/** Merge into one cross-chain record, guarded by `when` over the freshly loaded copy; the patch may be
 *  computed from that copy. Undefined when the id is gone or the guard rejects. */
export function updateCrossChainRecord(
	id: string,
	patch: Partial<CrossChainDepositRecord> | ((current: CrossChainDepositRecord) => Partial<CrossChainDepositRecord>),
	when: (current: CrossChainDepositRecord) => boolean = () => true,
): CrossChainDepositRecord | undefined {
	const written = journalPatchWhen<CrossChainDepositRecord>(deps.kv, id, when, patch)
	reload()
	return written
}

/** The persisted cross-chain record, read straight from storage. */
export function currentCrossChainRecord(id: string): CrossChainDepositRecord | undefined {
	if (discarding.has(id)) return undefined
	return loadCrossChainJournal(deps.kv).find((r) => r.id === id)
}

/** Every persisted cross-chain record. */
export function storedCrossChainRecords(): CrossChainDepositRecord[] {
	return loadCrossChainJournal(deps.kv)
}

/** Every rekey this tab performed, old id → new id, so a surface holding a provisional id can keep
 *  following its record after the transaction names it. Session-scoped, like `sessionLive`. */
const rekeyed = ref<Record<string, string>>({})

/** The id a record is filed under now, following every rekey since `id`; `id` itself when none. */
export function canonicalRecordId(id: string): string {
	let current = id
	const seen = new Set<string>()
	while (rekeyed.value[current] && !seen.has(current)) {
		seen.add(current)
		current = rekeyed.value[current] as string
	}
	return current
}

/** Provisional-record upgrade: replace the pending row under the id its own transaction gave it.
 *  Foreground ownership follows the rekey, or the stepper would lose its record mid-watch, and so
 *  does the runtime - the narration and the approve outcome describe the same attempt. */
export function rekeyJournalRecord(oldId: string, next: BridgeJournalRecord): void {
	rekeyRecord(deps.kv, oldId, next)
	adoptRekey(oldId, next.id)
}

function adoptRekey(oldId: string, nextId: string): void {
	if (sessionLive.delete(oldId)) sessionLive.add(nextId)
	if (activeFlowId.value === oldId) activeFlowId.value = nextId
	rekeyed.value = { ...rekeyed.value, [oldId]: nextId }
	const { [oldId]: carried, ...rest } = runtime.value
	if (carried) runtime.value = { ...rest, [nextId]: { ...carried, ...rest[nextId] } }
	moveEntry(loggedHashes, oldId, nextId)
	moveEntry(loggedSteps, oldId, nextId)
	reload()
}

/**
 * Re-key a withdraw record onto its exit hash and consume it as ONE handoff. Lock order: the
 * destination's record lock, then the journal lock for the guarded re-key, then the consume body
 * with nothing re-acquired (the locks are not reentrant). A throw after the re-key belongs to the
 * new id: the old id's runtime went with the record. "moved" = the guard refused; "held-*" = the
 * destination's runner is already someone's (nothing was re-keyed).
 */
export async function attachAndConsume(
	oldId: string,
	next: SendWithdrawRecord,
	guard: (live: BridgeJournalRecord, all: BridgeJournalRecord[]) => boolean,
): Promise<"attached" | "moved" | "held-elsewhere" | "held-local"> {
	let outcome: "attached" | "moved" = "moved"
	const ran = await withRecordLock(next.id, async () => {
		const rekeyed = await underJournalLock(() => rekeyRecordWhen(deps.kv, oldId, guard, next))
		if (!rekeyed) {
			reload()
			return
		}
		adoptRekey(oldId, next.id)
		outcome = "attached"
		try {
			await runWithdrawConsumeLocked(next.id)
		} catch (e) {
			surfaceRunFailure(next.id, e)
		}
	})
	return ran === "ran" ? outcome : ran
}

/** Drops a record. The in-memory side is immediate; the storage write waits for the journal lock, so a running
 *  claim's guarded write never interleaves with it in another tab. */
export function discard(id: string): Promise<void> {
	bumpGen(id) // Any in-flight run stops: a chunked round at its next generation check, a claim call at once.
	releaseForeground(id) // A discarded record can never be a valid takeover (CAS - only if it owns it).
	secretCache.delete(id)
	sessionLive.delete(id)
	localClaimProvenance.delete(id)
	receiptRounds.delete(id)
	dropPhaseClock(id)
	loggedHashes.delete(id)
	loggedSteps.delete(id)
	// Drop the runtime entry entirely - a discarded card must not resurrect stale state.
	const { [id]: _gone, ...rest } = runtime.value
	runtime.value = rest
	const remove = () => {
		removeRecord(deps.kv, id)
		discarding.delete(id)
		reload()
		// Re-derived from what SURVIVED, never from the record that left: two records can share a token.
		deps.retainPinnedTokens?.(sendTokenBlocks().map((t) => t.l2Token))
		log("discarded", id)
	}
	if (!deps.locks) {
		remove()
		return Promise.resolve()
	}
	// The removal waits for the journal lock; callers read the record as gone the moment they discard it.
	discarding.add(id)
	reload()
	return deps.locks.journal(remove).catch((e) => {
		discarding.delete(id)
		reload()
		log("discard failed - the record stays", id, e instanceof Error ? e.message : String(e))
	})
}

export const clearDone = discard

/**
 * A schema-3 record binds to ONE generation: the clone it names must be the factory's CREATE2 for
 * the ERC-20 in its token block, and its bridge must be that generation's hub. A gas-only send
 * carries no token and keeps the Fee Juice binding, against the generation's own portal.
 */
function sendDeploymentMatches(rec: SendJournalRecord): boolean {
	const binding = deps.sendBinding?.()
	if (!binding) return false
	if (rec.intent === "gas") {
		return (
			rec.portal?.toLowerCase() === binding.feeJuicePortal.toLowerCase() &&
			rec.bridge?.toLowerCase() === feeJuiceAddress.toLowerCase()
		)
	}
	const token = rec.token
	return (
		rec.bridge?.toLowerCase() === binding.hub.toLowerCase() &&
		rec.portal?.toLowerCase() === token.portal.toLowerCase() &&
		token.portal.toLowerCase() === predictPortal(binding.factory, binding.implementation, token.erc20)
	)
}

/**
 * Deployment binding: a record from another deployment never resumes (stale-deployment). A record
 * predating the generation binds to contracts this app no longer talks to — only a direct Fee Juice
 * bridge survives that cut, because the canonical FeeJuicePortal + the L2 Fee Juice address are
 * protocol addresses rather than generation ones.
 */
export function deploymentMatches(rec: BridgeJournalRecord): boolean {
	if (rec.chainId !== NETWORK.l1ChainId) return false
	if (runsAsSend(rec)) return sendDeploymentMatches(rec)
	return (
		assetKindOf(rec) === "fee-juice" &&
		rec.portal?.toLowerCase() === FUEL_PORTAL.toLowerCase() &&
		rec.bridge?.toLowerCase() === feeJuiceAddress.toLowerCase()
	)
}

/** Every distinct token a schema-3 record holds — the boot input to the app's wallet grant set,
 *  so a resumed lane's token is already covered by the first prompt. */
export function sendTokenBlocks(): JournalTokenBlock[] {
	const seen = new Map<string, JournalTokenBlock>()
	for (const rec of engineRecords()) {
		if (runsAsSend(rec) && rec.intent !== "gas") seen.set(rec.token.l2Token.toLowerCase(), rec.token)
	}
	return [...seen.values()]
}

/**
 * Prove every distinct token block the journal holds against the factory, and return the ones that
 * still hold. Storage is attacker-writable, and a block reaches the wallet as a grant request AND a
 * contract registration built from ITS words — so nothing persisted may be handed over before the
 * chain has vouched for it. A contradicted block blocks its records (terminal, as on the claim
 * lane); a chain that cannot answer proves nothing, so its block is simply left out rather than
 * blocked on a transport failure.
 */
export async function attestSendTokenBlocks(): Promise<JournalTokenBlock[]> {
	if (!deps.validateTokenBlock) throw new Error("Journal deps not connected")
	const attested: JournalTokenBlock[] = []
	for (const token of sendTokenBlocks()) {
		let reason: string | null
		try {
			reason = await deps.validateTokenBlock(token)
		} catch (e) {
			log("token block attestation unavailable - leaving it unpinned", e instanceof Error ? e.message : String(e))
			continue
		}
		if (reason === null) attested.push(token)
		else blockTokenRecords(token, reason)
	}
	return attested
}

function blockTokenRecords(token: JournalTokenBlock, reason: string): void {
	const key = token.l2Token.toLowerCase()
	for (const rec of engineRecords()) {
		if (!runsAsSend(rec) || rec.intent === "gas" || rec.token.l2Token.toLowerCase() !== key) continue
		patchRecord(rec.id, { blocked: reason })
		setRuntime(rec.id, { attention: "stale-deployment", note: reason })
	}
}

/** Copy for a grant that did not end in an approval; "stale" means a newer selection superseded it. */
const grantNote = (outcome: GrantOutcome): string =>
	outcome === "declined"
		? "Your wallet hasn't granted access to this token yet — press Claim and approve the request."
		: "The token grant was superseded by a newer selection — press Claim to request it again."

/**
 * The block check both send lanes run before anything is granted or executed. A mismatch is
 * TERMINAL - the record is blocked rather than silently corrected, because a rewritten block
 * would move a different L2 token than the one the deposit committed to.
 */
async function checkTokenBlock(token: JournalTokenBlock, id: string): Promise<"stop" | "proceed"> {
	if (!deps.validateTokenBlock) throw new Error("Journal deps not connected")
	const reason = await deps.validateTokenBlock(token)
	if (!reason) return "proceed"
	patchRecord(id, { blocked: reason })
	setRuntime(id, { attention: "stale-deployment", note: reason })
	return "stop"
}

/** The deposit lane's preflight: the block check, then the wallet grant for that token. */
async function prepareSendLane(rec: SendJournalRecord, id: string): Promise<"stop" | "proceed"> {
	if (rec.intent === "gas") return "proceed"
	if (!deps.ensureTokenGrant) throw new Error("Journal deps not connected")
	if ((await checkTokenBlock(rec.token, id)) === "stop") return "stop"
	const outcome = await deps.ensureTokenGrant(rec.token)
	if (outcome === "granted") return "proceed"
	setRuntime(id, { attention: "error", note: grantNote(outcome) })
	return "stop"
}

/** Whether a recovery file's HEADER could belong to this generation's send lane. The header is
 *  unauthenticated, so this only decides whether to attempt the unseal; the record's own binding
 *  and token block are checked afterwards. */
export function sendHeaderMatches(chainId: number, bridge: string): boolean {
	const binding = deps.sendBinding?.()
	return !!binding && chainId === NETWORK.l1ChainId && bridge.toLowerCase() === binding.hub.toLowerCase()
}

/** The import path's authoritative check: a restored send record proves its block against the
 *  factory before it is ever tracked. Returns the refusal reason, or null when it holds. */
export async function validateSendRecordBlock(rec: BridgeJournalRecord): Promise<string | null> {
	if (!runsAsSend(rec) || rec.intent === "gas") return null
	if (!deps.validateTokenBlock) throw new Error("Journal deps not connected")
	return deps.validateTokenBlock(rec.token)
}

/** A record the chain has contradicted never runs again - only discarding it clears the state. */
function guardBlocked(rec: BridgeJournalRecord): boolean {
	if (!rec.blocked) return true
	setRuntime(rec.id, { attention: "stale-deployment", note: safeSentence(rec.blocked) })
	return false
}

function guardDeployment(rec: BridgeJournalRecord): boolean {
	if (deploymentMatches(rec)) return true
	setRuntime(rec.id, { attention: "stale-deployment", note: "This record belongs to a different bridge deployment." })
	return false
}

/**
 * Resolve a private deposit's secret + authoritative metadata. Same-session: served from the
 * in-memory cache, ZERO signatures. Rediscovered: one L1 signature re-derives the per-record key,
 * the v2 envelope is opened (the ONLY accepted shape) and verified against the record's display
 * fields; mismatch rewrites the display from the envelope and stops for an explicit re-click.
 */
/** A REJECTED signature prompt is not an unseal failure: no key was derived, nothing tested -
 *  revoking trust there would re-impose the 2-signature self-test for a change of mind. A real
 *  open failure revokes trust ONLY for the account that claims to have sealed this record - a
 *  wrong-account attempt must not destroy the connected account's valid verdict. */
function handleUnsealFailure(rec: ClaimRecord, e: unknown, connected: string | null): void {
	if (isUserRejection(e)) {
		setRuntime(rec.id, { attention: "error", note: "Signature request declined — press Claim when you're ready." })
		return
	}
	if (connected && rec.sealerL1 && connected === rec.sealerL1.toLowerCase()) {
		revokeSealTrust(deps.kv, rec.chainId, connected)
	}
	setRuntime(rec.id, {
		attention: "unseal-failed",
		note: "Your signature didn't open this record. If this address lives in more than one wallet app, retry with the one used at deposit time. Nothing was deleted.",
	})
}

/**
 * A cross-chain record seals a v3 amount window until its deposit is final. Opened with the key in hand, it
 * reads as the exact envelope of the deposit as found, and is re-sealed exact once that deposit is final, so
 * every later open reads an ordinary v2 envelope. Null when the deposit is not known yet or falls outside
 * the sealed window.
 */
export async function openClaimEnvelope(key: EncryptionKey, rec: ClaimRecord, blob: string): Promise<DepositEnvelopeV2 | null> {
	const xc = rec as AnyJournalRecord
	if (!isCrossChainRecord(xc)) return openDepositEnvelope(key, blob)
	const v3 = await openDepositEnvelopeV3(key, blob).catch(() => null)
	if (!v3) return openDepositEnvelope(key, blob)
	if (!xc.leafIndex || !envelopeV3MatchesRecord(v3, xc)) return null
	const deposited = { recipient: xc.recipient, amount: xc.amount, leafIndex: xc.leafIndex }
	if (xc.route.depositFinal) {
		const sealedEnvelope = await resealExactEnvelope(key, v3, deposited)
		await underJournalLock(() => patchRecord(xc.id, { sealedEnvelope }))
	}
	return { v: 2, secret: v3.secret, sealerL1: v3.sealerL1, ...deposited, ...(v3.salt ? { salt: v3.salt } : {}) }
}

const OUTSIDE_SEALED_WINDOW = "This deposit doesn't match its sealed copy, so it can't be claimed from here. Nothing was deleted."

async function resolvePrivateSecret(rec: ClaimRecord): Promise<{ secretHex: string; envelope: DepositEnvelopeV2 } | null> {
	const cached = cachedMaterial(rec)
	if (cached) return cached
	if (!deps.signL1) {
		setRuntime(rec.id, { attention: "error", note: "Connect your Ethereum wallet to unseal this claim." })
		return null
	}
	if (!rec.sealedEnvelope) {
		setRuntime(rec.id, { attention: "stale", note: "This record has no sealed secret — it cannot be claimed." })
		return null
	}
	const connected = deps.connectedL1?.()?.toLowerCase() ?? null
	if (rec.sealerL1 && connected && connected !== rec.sealerL1.toLowerCase()) {
		setRuntime(rec.id, {
			attention: "mismatch",
			note: `Connect the Ethereum account that sealed this record (${safeAddressText(rec.sealerL1)}).`,
		})
		return null
	}
	const binding = { chainId: rec.chainId, portal: rec.portal, bridge: rec.bridge, secretHashHex: rec.secretHashHex }
	let envelope: DepositEnvelopeV2 | null
	try {
		const key = await recoveryKeyFromSignature(
			await runOnLane("l1", () => deps.signL1?.(recoveryKeyMessage(binding)) as Promise<string>),
		)
		envelope = await openClaimEnvelope(key, rec, rec.sealedEnvelope)
	} catch (e) {
		handleUnsealFailure(rec, e, connected)
		return null
	}
	if (!envelope) {
		setRuntime(rec.id, { attention: "tampered", note: OUTSIDE_SEALED_WINDOW })
		return null
	}
	if (envelope.sealerL1 && connected && envelope.sealerL1.toLowerCase() !== connected) {
		setRuntime(rec.id, {
			attention: "mismatch",
			note: `This record was sealed by ${safeAddressText(envelope.sealerL1)} — connect that Ethereum account.`,
		})
		return null
	}
	if (!envelopeMatchesRecord(envelope, rec)) {
		// The display lied; the envelope is the authenticated truth. Rewrite + require a re-click.
		const shown = { recipient: envelope.recipient, amount: envelope.amount, leafIndex: envelope.leafIndex ?? rec.leafIndex }
		await underJournalLock(() => patchRecord(rec.id, shown))
		setRuntime(rec.id, {
			attention: "tampered",
			note: "Stored details didn't match the sealed copy — showing the sealed values. Review and claim again.",
		})
		return null
	}
	const resolved = { secretHex: envelope.secret, envelope }
	secretCache.set(rec.id, resolved)
	return resolved
}

/** Per-record dedup wrapper: process-local first, then the cross-tab record lock when one is wired —
 *  a runner another tab holds is skipped exactly like an in-flight duplicate here. `quiet`: the run shows on its own
 *  control, so the record does not read as busy meanwhile. */
async function withRecordLock(id: string, fn: () => Promise<void>, quiet = false): Promise<"ran" | "held-local" | "held-elsewhere"> {
	if (inFlight.has(id)) {
		log("already in flight - skipping duplicate", id)
		return "held-local"
	}
	// Local ownership is taken BEFORE the lock request: the grant is asynchronous, and two immediate
	// starts in one tab would otherwise both reach it, the loser reading as another tab's runner.
	inFlight.add(id)
	try {
		const body = () => (quiet ? fn() : runRecordBody(id, fn))
		if (!deps.locks) {
			await body()
			return "ran"
		}
		const outcome = await deps.locks.record(id, body)
		if (outcome !== HELD_ELSEWHERE) return "ran"
		log("already in flight in another tab - skipping duplicate", id)
		return "held-elsewhere"
	} finally {
		inFlight.delete(id)
	}
}

/** A runner another tab holds is told so on the card; a local duplicate keeps the running one's
 *  narration untouched. */
function noteHeldElsewhere(id: string, what: string): void {
	if (!engineRecords().some((r) => r.id === id)) return
	setRuntime(id, { attention: "unknown-outcome", note: `Another tab is ${what} — try again in a moment.` })
}

async function runRecordBody(id: string, fn: () => Promise<void>): Promise<void> {
	setRuntime(id, { busy: true })
	try {
		await fn()
	} finally {
		// Structural step cleanup: narration never outlives the runner, success or throw - but never
		// resurrect a runtime entry for a record that was discarded while we ran.
		if (engineRecords().some((r) => r.id === id)) {
			setRuntime(id, { busy: false, step: undefined, stepDetail: undefined })
		}
	}
}

const wait = (ms: number): Promise<void> => (deps.waitMs ? deps.waitMs(ms) : new Promise((r) => setTimeout(r, ms)))

const RECEIPT_POLLS_PER_ROUND = 45 // ×4s ≈ one ~3-minute round inside the lock.
const RECEIPT_MAX_ROUNDS = 10 // ≈30 min soft cap; after it the card re-arms RETRY, never a dead-end.
const INTER_ROUND_MS = 100

/** The most recent verified completion, for the completion toast. `assetKind` picks the toast's
 *  wording; `display` is the record's own amount and symbol. */
export const lastCompleted = ref<{
	id: string
	direction: "deposit" | "withdraw"
	display: DisplayAmount
	isPrivate: boolean
	assetKind: "bridge-token" | "fee-juice"
	txHash?: string
	/** Captured SYNCHRONOUSLY at completion, before the form's watcher releases the takeover - the
	 *  toast must key off this, not the live activeFlowId (already null by the time it runs). */
	foreground: boolean
} | null>(null)

function setStep(id: string, step?: BridgeStep, stepDetail?: string): void {
	setRuntime(id, { step, stepDetail, ...(step === undefined ? {} : stepLogPatch(id, step)) })
}

/** The flows' narration channel into the per-record runtime. An empty id is a caller
 *  narrating before it created its record: the runtime entry it would write is unreachable and the
 *  step it describes would never appear anywhere, so it fails loudly instead. */
export function setRecordStep(id: string, step?: BridgeStep, stepDetail?: string): void {
	if (id === "") throw new Error("setRecordStep: narrating a step before the record exists")
	setStep(id, step, stepDetail)
}

/** Display-only: discovery finished a read of the chains for `id` at `at`. */
export function markRecordChecked(id: string, at: number): void {
	setRuntime(id, { checkedAt: at })
}

/** Display-only APPROVE outcome - written when a real approval tx lands. */
export function markApproveOutcome(id: string, outcome: "done"): void {
	setRuntime(id, { approveOutcome: outcome })
}

/** Display-only PERMISSION outcome - written when this run raised the wallet's token grant. */
export function markGrantOutcome(id: string): void {
	setRuntime(id, { grantOutcome: "done" })
}

/** Surface a flow-leg failure on the record (the stepper/card render it; the engine is untouched). */
export function flagRecordError(id: string, note: string): void {
	setRuntime(id, { attention: "error", note })
}

/** Lifts `flagRecordError`'s flag once the record is seen in flight again; any other attention stays. */
export function clearRecordError(id: string): void {
	if (runtime.value[id]?.attention === "error") setRuntime(id, { attention: undefined, note: undefined })
}

/**
 * Foreground ownership: UI-owned, compare-and-swap. While a record is foreground, the
 * journal list suppresses its card - the stepper/receipt is its only surface. In-memory only:
 * a reload structurally fails open (the card appears). Flow promises never touch this.
 */
export const activeFlowId = ref<string | null>(null)

export function claimForeground(id: string): void {
	activeFlowId.value = id
}

/** CAS release: a stale owner (backgrounded, superseded, settled flow) cannot clear the current one. */
export function releaseForeground(id: string): void {
	if (activeFlowId.value === id) activeFlowId.value = null
}

/** One guarded journal write under the cross-tab journal lock (a plain deferred call without one):
 *  the body is the synchronous load → guard → write span, so nothing interleaves inside it. */
export function underJournalLock<T>(fn: () => T): Promise<T> {
	return deps.locks ? deps.locks.journal(fn) : Promise.resolve().then(fn)
}

/** The in-memory side of a deposit completion, after its `completedAt` is persisted. */
function finishDeposit(rec: ClaimRecord): void {
	setRuntime(rec.id, { attention: undefined, note: undefined })
	secretCache.delete(rec.id)
	receiptRounds.delete(rec.id)
	lastCompleted.value = {
		id: rec.id,
		direction: "deposit",
		display: displayAmountOf(engineRecords().find((r) => r.id === rec.id) ?? rec),
		isPrivate: rec.isPrivate,
		assetKind: assetKindOf(rec),
		txHash: rec.claimTxHash,
		foreground: activeFlowId.value === rec.id,
	}
	// Completed cards STAY (✓ + the ✕ dismiss) - auto-hide was provenance-scoped and read as
	// "sometimes my card vanishes". The foreground receipt path releases its takeover on completion,
	// so the finished record lands in the history list alongside the receipt.
	localClaimProvenance.delete(rec.id)
	log("deposit complete", rec.id)
}

function completeWithdraw(rec: ExitRecord | undefined, consumeTxHash?: string): void {
	if (!rec) return
	const current = engineRecords().find((r) => r.id === rec.id)
	if (!current || current.completedAt) return
	patchRecord(rec.id, { completedAt: deps.now() })
	setRuntime(rec.id, { attention: undefined, note: undefined })
	receiptRounds.delete(rec.id)
	lastCompleted.value = {
		id: rec.id,
		direction: "withdraw",
		display: displayAmountOf(rec),
		isPrivate: rec.isPrivate,
		assetKind: assetKindOf(rec),
		txHash: consumeTxHash,
		foreground: activeFlowId.value === rec.id,
	}
	log("withdraw complete", rec.id)
}

/**
 * The deposit claim: the app's guards and claim material, then the SDK's claim entry on the record's view, its events
 * narrated on the card. Explicit-click only for rediscovered records; the deposit flow calls it directly for sessionLive
 * ones.
 */
export async function runDepositClaim(id: string, opts: ClaimRunOptions = {}): Promise<void> {
	try {
		// withOperation wraps EACH spawned continuation (this is the single entry point for card
		// retries and resumeSessionWork) — never the void dispatcher, which would release the switch
		// gate immediately.
		await withOperation(() => runDepositClaimInner(id, opts))
	} catch (e) {
		surfaceRunFailure(id, e)
	}
}

/** `interactive`: a click, which may ask for the unseal signature. `watchOnly`: no wallet is asked, the unseal included;
 *  by default a run nobody clicked for on a record this session did not start. */
export interface ClaimRunOptions {
	interactive?: boolean
	watchOnly?: boolean
}

interface ClaimMode {
	interactive: boolean
	watchOnly: boolean
}

/** Failures from the run entrypoints land on the RECORD (every UI call site voids the promise). */
function surfaceRunFailure(id: string, e: unknown): void {
	const msg = humanizeWalletError(e instanceof Error ? e.message : String(e))
	log("run failed:", id, msg)
	if (!engineRecords().some((r) => r.id === id)) return
	setRuntime(id, { attention: "error", note: `${msg}. Your funds are not lost — retry from this card.` })
}

async function runDepositClaimInner(id: string, opts: ClaimRunOptions): Promise<void> {
	const watchOnly = opts.watchOnly ?? (opts.interactive === false && !sessionLive.has(id))
	const mode: ClaimMode = { interactive: opts.interactive !== false && !watchOnly, watchOnly }
	let next = "stop" as ClaimRun
	let gen = 0
	const ran = await withRecordLock(id, async () => {
		// This runner is now the record's owner - any previously scheduled round dies silently.
		gen = bumpGen(id)
		next = await runDepositClaimLocked(id, gen, mode)
	})
	if (ran === "held-elsewhere") noteHeldElsewhere(id, "claiming this deposit")
	// Re-entry happens OUTSIDE the lock so RETRY/DISCARD stay reachable between rounds; a claim whose deposit
	// moved starts over from the record's new facts. Either way the run keeps its mode.
	if (next === "stop" || genOf(id) !== gen) return
	if (next === "continue") await wait(INTER_ROUND_MS)
	if (genOf(id) === gen) void runDepositClaim(id, { interactive: false, watchOnly: mode.watchOnly })
}

/** `continue`: schedule another receipt round; `restart`: the deposit the claim was built for moved. */
type ClaimRun = "continue" | "stop" | "restart"

/** The lock-held claim sequence: the app's guards, then the SDK's claim. Returns what the caller schedules outside
 *  the lock. */
async function runDepositClaimLocked(id: string, gen: number, mode: ClaimMode): Promise<ClaimRun> {
	const rec = claimTarget(id)
	if (!rec) return "stop"
	if (rec.claimTxHash !== undefined && !isWellFormedTxHash(rec.claimTxHash)) return reportMalformedClaimHash(rec.id)
	// A deposit no SDK claim reads is a Fee Juice record without its gas block: there is nothing to claim.
	if (!claimView(rec as AnyJournalRecord)) throw new Error(FEE_STOP_COPY["no-claimable-fuel"])
	if (claimsThroughHub(rec) && markerApplies(rec)) return verifyClaimedByOther(rec, gen, mode)
	if ((await claimGuards(rec, id)) === "stop") return "stop"
	if (legLeftAlone(rec)) return "stop"
	const material = await claimMaterialFor(rec, gen, mode)
	if (typeof material === "string") return material
	return runClaim(id, gen, mode, material.value)
}

/** A persisted claim hash the node cannot be asked about is a RECORD problem (corrupted or
 *  hand-edited storage), not a receipt state: the receipt read would fail as "unreachable", the round would narrate
 *  connectivity, and after the cap the card would say "slow testnet" while every retry repeated. Terminal: only a
 *  restore or a discard fixes it. */
function reportMalformedClaimHash(id: string): "stop" {
	setRuntime(id, {
		attention: "malformed-record",
		note: "This record's claim transaction hash is malformed — restore the record from a backup, or discard it.",
	})
	return "stop"
}

/** The runnable claim target, or undefined: completed/absent/wrong-deployment/blocked records
 *  don't run; missing engine deps throw (a wiring bug, not a record state). Synchronous — the
 *  head guards keep the original's no-await entry. */
function claimTarget(id: string): ClaimRecord | undefined {
	const rec = engineRecords().find((r) => r.id === id && r.direction === "deposit") as ClaimRecord | undefined
	if (!rec || claimRetired(rec)) return undefined
	if (crossChainUnclaimable(rec)) return undefined
	if (!guardBlocked(rec) || !guardDeployment(rec)) return undefined
	if (!deps.claimEntries || !deps.claimContext) throw new Error("Journal deps not connected")
	return rec
}

/** Until its deposit lands, and after it ended anywhere else, a cross-chain record belongs to its watcher:
 *  there is no message on Aztec to claim. */
function crossChainUnclaimable(rec: ClaimRecord): boolean {
	const any = rec as AnyJournalRecord
	return isCrossChainRecord(any) && (any.leafIndex === undefined || any.route.outcome !== undefined)
}

/** Only a token-moving send goes through the hub; a gas-only send is still a Fee Juice claim. */
const claimsThroughHub = (rec: ClaimRecord): rec is SendDepositRecord => runsAsSend(rec) && rec.intent !== "gas"

/** The pre-claim guards in order: recipient identity, then a send record's block validation and
 *  its wallet grant — both BEFORE any claim is started or any transaction is signed. */
async function claimGuards(rec: ClaimRecord, id: string): Promise<"stop" | "proceed"> {
	if (recipientMismatch(rec, id)) return "stop"
	return runsAsSend(rec) ? prepareSendLane(rec, id) : "proceed"
}

/** Pre-click recipient guard (ALL deposit claims): the claim acts
 *  for rec.recipient; it must never run while a DIFFERENT Aztec account is active, or the
 *  chip shows B while an action executes for A. Private claims additionally mint a NOTE to
 *  the recipient. Auto-resume respects the same rule: a mismatched record waits with a
 *  mismatch card until its account is active again. Fail-CLOSED: no known
 *  active account is treated like a mismatch — never run a claim on the hope that the right
 *  account happens to be connected; a non-string/empty recipient (tampered localStorage) is
 *  refused the same way instead of bypassing the compare and failing deep in address parsing. */
function recipientMismatch(rec: ClaimRecord, id: string): boolean {
	const aztec = deps.connectedAztec?.() ?? null
	const recipientOk = typeof rec.recipient === "string" && rec.recipient.length > 0
	if (!aztec || !recipientOk || aztec.toLowerCase() !== rec.recipient.toLowerCase()) {
		setRuntime(id, {
			attention: "mismatch",
			note: `This deposit claims to ${safeAddressText(rec.recipient)}. Switch to that Aztec account to claim.`,
		})
		return true
	}
	return false
}

/** The deposit facts a claim stands on, as the SDK's claims require them: the leaf of every message it consumes, and
 *  for a gas leg its message key and the Fee Juice it carries. */
function factsMissing(rec: ClaimRecord): boolean {
	const fuel = rec.fuel
	const fuelLeaves = !!fuel?.leafIndex && !!fuel.messageHash && fuel.received !== undefined
	const gasOnly = assetKindOf(rec) === "fee-juice" || (runsAsSend(rec) && rec.intent === "gas")
	return gasOnly ? !fuelLeaves : !rec.leafIndex || (fuel !== undefined && !fuelLeaves)
}

/** Records whose missing facts nothing here recovers: a hash-less deposit other than a hub token send waits for the
 *  flow that owns it, and a deposit predating the generation cannot be read back from its receipt. */
function legLeftAlone(rec: ClaimRecord): boolean {
	if (!factsMissing(rec)) return false
	if (!rec.depositTxHash && (rec.schema === 2 || !claimsThroughHub(rec))) {
		log("no leafIndex yet - the deposit leg is still running", rec.id)
		return true
	}
	if (rec.schema !== 2) return false
	setRuntime(rec.id, { attention: "error", note: humanizeWalletError(FEE_STOP_COPY["record-predates-send"]) })
	return true
}

function reportDepositSearch(id: string, outcome: DepositSearch): "stop" {
	if (outcome === "none") {
		setRuntime(id, {
			attention: "error",
			note: "No deposit for this record was found on Ethereum since it was started. If you never confirmed it in your wallet, discard this record.",
		})
	} else if (outcome === "ambiguous") {
		setRuntime(id, {
			attention: "unknown-outcome",
			note: "More than one matching deposit was found — not guessing. Keep this record and export its recovery file; it can be finished by hand.",
		})
	} else {
		setRuntime(id, { attention: "error", note: "Ethereum could not be searched far enough back — try again later." })
	}
	return "stop"
}

/**
 * The claim material a run needs before the SDK's claim: a private record's unsealed secrets, or nothing (a public
 * record's secret is on the record). A sent claim is watched without them unless a click unseals; a record that must
 * first recover its deposit's facts recovers them before the unseal signature, so a deposit Ethereum has not confirmed
 * costs no prompt.
 */
async function claimMaterialFor(rec: ClaimRecord, gen: number, mode: ClaimMode): Promise<{ value?: ClaimMaterial } | ClaimRun> {
	if (!rec.isPrivate) return rec.claimTxHash || publicClaimSecretOf(rec) ? {} : reportNoSecret(rec.id)
	const cached = cachedMaterial(rec)
	if (cached) return { value: cached }
	if (rec.claimTxHash) {
		if (!mode.interactive || !rec.sealedEnvelope) return {}
		const resolved = await resolvePrivateSecret(rec)
		return resolved ? { value: resolved } : "stop"
	}
	return unsentPrivateMaterial(rec, gen, mode)
}

/** An unsent private claim's material: the deposit's facts first, so an unconfirmed deposit costs no signature, and
 *  none for a watching run, which would stop at the claim's prompt anyway. */
async function unsentPrivateMaterial(rec: ClaimRecord, gen: number, mode: ClaimMode): Promise<{ value?: ClaimMaterial } | ClaimRun> {
	let target = rec
	if (factsMissing(rec)) {
		const recovered = await recoverDepositFacts(rec, gen)
		if (typeof recovered === "string") return recovered
		target = recovered
	}
	if (mode.watchOnly) return "stop"
	const material = await resolvePrivateClaimMaterial(target, target.id)
	return material ? { value: material } : "stop"
}

/** A watching call that stops once the deposit's facts are on the record: what a claim reads before any prompt. */
async function recoverDepositFacts(rec: ClaimRecord, gen: number): Promise<ClaimRecord | ClaimRun> {
	const result = await claimCall(rec, gen, { target: targetOf(rec), watchOnly: true, factsOnly: true })
	if ("call" in result && result.call.stopped === "facts") {
		const live = engineRecords().find((r) => r.id === rec.id) as ClaimRecord | undefined
		return live && !factsMissing(live) ? live : "stop"
	}
	return claimEnded(rec.id, result)
}

/** The claim material: for a private record the unsealed authoritative copy. Null = the run must stop (already
 *  narrated). */
async function resolvePrivateClaimMaterial(rec: ClaimRecord, id: string): Promise<ClaimMaterial | null> {
	// Only narrate UNSEALING when a real signature is needed (a rediscovered record): "unsealing" maps to CLAIM on the
	// rail, and a cached secret's instant unseal would flash CLAIM before the claim's arrival narration regresses it.
	if (!secretCache.has(id)) setStep(id, "unsealing", "one Ethereum signature")
	return resolvePrivateSecret(rec)
}

/**
 * A public record's claim credential, from the ONE place that holds it. A gas-only send has no
 * token leg, so the secret its L1 message committed to lives in the fuel block and nowhere else —
 * a top-level copy would be a second source of truth for the same value, free to drift from the
 * block the claim actually spends.
 */
function publicClaimSecretOf(rec: ClaimRecord): string | undefined {
	return runsAsSend(rec) && rec.intent === "gas" ? rec.fuel?.secret : rec.secret
}

function reportNoSecret(id: string): "stop" {
	setRuntime(id, { attention: "stale", note: "This record has no claim secret — it cannot be claimed." })
	return "stop"
}

/** What the SDK's claim needs from the unsealed envelope: the token's claim salt, and the gas leg's salt, which the
 *  claim otherwise reads from the record's plaintext copy. A gas-only record's credential is its gas salt. */
function secretsOf(rec: ClaimRecord, material: ClaimMaterial | undefined): DepositSecrets | undefined {
	const envelope = material?.envelope
	if (!envelope) return undefined
	const fuelSalt = envelope.salt ? Fr.fromString(envelope.salt) : undefined
	const claimSalt = targetOf(rec) === "token" ? Fr.fromString(material.secretHex) : undefined
	return { ...(claimSalt ? { claimSalt } : {}), ...(fuelSalt ? { fuelSalt } : {}) }
}

type ClaimTarget = "token" | "gas" | "gas-leg"

const targetOf = (rec: ClaimRecord): ClaimTarget => (claimsThroughHub(rec) ? "token" : "gas")

/** One SDK claim of a record: which entry, whether it may prompt, and whether it stops once the facts are read. */
interface CallPlan {
	target: ClaimTarget
	watchOnly: boolean
	material?: ClaimMaterial
	factsOnly?: boolean
	/** The tokens already landed elsewhere: every failure is the gas claim's. */
	landed?: boolean
}

/** The card's gas claim shows its progress on its own button and watches its receipt for `GAS_CLAIM_POLLS` reads. */
const quietCall = (call: ClaimCall) => call.target === "gas-leg"

/** Why the engine stopped a call: a receipt round ended, a newer runner or a discard took the record, discovery moved
 *  the deposit, Ethereum has not confirmed the deposit, or the facts a pre-unseal call was for are read. */
type StopReason = "round" | "generation" | "moved" | "ethereum" | "facts"

interface ClaimCall {
	target: ClaimTarget
	controller: AbortController
	stopped?: StopReason
	scene: ClaimScene
	/** The record as the SDK last persisted it: the base of its next field delta. */
	base: DepositRecord
	factsOnly: boolean
}

type CallResult = { run: ClaimRun } | { outcome: ClaimOutcome; call: ClaimCall } | { error: unknown; call: ClaimCall }

/** The call each record's generation stops: one at a time, under the record lock. */
const activeCalls = new Map<string, ClaimCall>()

function stopCall(call: ClaimCall, reason: StopReason): void {
	if (call.stopped) return
	call.stopped = reason
	call.controller.abort()
}

/** What a call runs with: the session's reads and signer, and the network checked once they answer. */
interface CallSetup {
	ctx: ClaimContext
	net: Network
}

async function setUpCall(rec: ClaimRecord, gen: number, watchOnly: boolean): Promise<CallSetup | ClaimRun> {
	const ctx = await (deps.claimContext as NonNullable<JournalEngineDeps["claimContext"]>)({ recipient: rec.recipient, watchOnly })
	const net = await checkedNetwork(rec, ctx, gen)
	if (typeof net === "string") return net
	return genOf(rec.id) === gen ? { ctx, net } : "stop"
}

/** One call into the SDK's claim for `rec`, narrated on its card, its writes guarded field deltas under the journal
 *  lock, stoppable by the record's generation, a round's end and a moved deposit. */
async function claimCall(rec: ClaimRecord, gen: number, plan: CallPlan, setup?: CallSetup): Promise<CallResult> {
	const ready = setup ?? (await setUpCall(rec, gen, plan.watchOnly))
	if (typeof ready === "string") return { run: ready }
	const view = claimView(rec as AnyJournalRecord) as DepositRecord
	const call: ClaimCall = {
		target: plan.target,
		controller: new AbortController(),
		scene: {
			...newScene(runtime.value[rec.id]?.claimable === true, localClaimProvenance.has(rec.id)),
			...(plan.landed ? { landed: "claimed-elsewhere" as const } : {}),
		},
		base: view,
		factsOnly: plan.factsOnly === true,
	}
	activeCalls.set(rec.id, call)
	const unwatch = watchDepositMove(rec, call)
	try {
		const outcome = await claimEntry(plan.target)(ready.net, ready.ctx.reads, ready.ctx.aztec, view, {
			persist: (next) => persistClaimDelta(rec.id, call, next),
			onEvent: (e) => onClaimEvent(rec.id, call, e),
			signal: call.controller.signal,
			secrets: secretsOf(rec, plan.material),
			watchOnly: plan.watchOnly,
			// A private claim always claims its private gas: settling without it would strand the sealed salt.
			withoutGas: !rec.isPrivate && deps.withoutGas?.(rec.id) === true,
		})
		return { outcome, call }
	} catch (error) {
		if (refusedByMove(rec, error)) {
			await wait(RECEIPT_POLL_MS)
			stopCall(call, "moved")
		}
		return { error, call }
	} finally {
		unwatch()
		if (activeCalls.get(rec.id) === call) activeCalls.delete(rec.id)
	}
}

function claimEntry(target: ClaimTarget): ClaimEntry {
	const entries = deps.claimEntries as NonNullable<JournalEngineDeps["claimEntries"]>
	return target === "token" ? entries.token : entries.fuel
}

/** The claim's write: what changed since its last write, refused when the record is gone, is another deposit, or a
 *  field it changes was changed by another writer meanwhile. */
async function persistClaimDelta(id: string, call: ClaimCall, next: DepositRecord): Promise<void> {
	await underJournalLock(() => patchRecordDelta(deps.kv, id, call.base, next))
	call.base = next
	reload()
}

/** Discovery re-finding a cross-chain fill at another leaf (or losing it) moves the deposit the claim waits for; the
 *  claim starts over from the new facts. Noticed one poll after the write, as a gate notices it, so discovery has
 *  re-cached the new deposit's material by then. */
function watchDepositMove(rec: ClaimRecord, call: ClaimCall): () => void {
	if (!isCrossChainRecord(rec as AnyJournalRecord)) return () => undefined
	let noticing = false
	return watch(
		() => crossChainRecords.value.find((r) => r.id === rec.id),
		() => {
			if (noticing || !depositMovedFrom(rec.id, call)) return
			noticing = true
			void wait(RECEIPT_POLL_MS).then(() => {
				noticing = false
				if (depositMovedFrom(rec.id, call)) stopCall(call, "moved")
			})
		},
		// A move that landed while the call was set up counts too.
		{ immediate: true },
	)
}

/** A write the identity guard refused on a cross-chain record: discovery's move, met before the watch's delay ran out,
 *  so the claim restarts after the same delay. */
function refusedByMove(rec: ClaimRecord, e: unknown): boolean {
	return (
		isCrossChainRecord(rec as AnyJournalRecord) &&
		isBridgeError(e) &&
		e.code === "persist-failed" &&
		e.cause instanceof RecordDeltaRefused &&
		e.cause.reason === "identity"
	)
}

/** The stored record no longer holds the deposit the claim last wrote, or is gone. */
function depositMovedFrom(id: string, call: ClaimCall): boolean {
	const stored = crossChainRecords.value.find((r) => r.id === id)
	const view = stored ? claimView(stored as AnyJournalRecord) : undefined
	return !view || !sameClaimIdentity(view, call.base)
}

function onClaimEvent(id: string, call: ClaimCall, e: TransferEvent): void {
	if (call.stopped) return
	if (quietCall(call)) {
		if (e.type === "claim-waiting" && e.poll > GAS_CLAIM_POLLS) stopCall(call, "round")
		return
	}
	// The wait after a hash's last poll of the round ends it: the record lock is released and the run re-enters.
	if (e.type === "claim-waiting" && e.poll > RECEIPT_POLLS_PER_ROUND) {
		stopCall(call, "round")
		return
	}
	if (e.type === "claim-sent") {
		receiptRounds.delete(id)
		localClaimProvenance.add(id)
	}
	const narration = narrateClaim(e, call.scene, runtime.value[id], (currentRecord(id) as ClaimRecord | undefined)?.claimTxHash)
	if (narration.runtime) setRuntime(id, narration.runtime)
	if (narration.step) setStep(id, narration.step.step, narration.step.detail)
	if (e.type === "deposit-recovery" && e.stage === "waiting") stopCall(call, "ethereum")
	if (e.type === "deposit-confirmed" && call.factsOnly) stopCall(call, "facts")
}

const UNCHECKED_NETWORK = "This app could not check the bridge on this network. Nothing was sent."
const RECEIPT_POLL_MS = 4000
/** ×4s ≈ four minutes: how long the card's gas claim watches its receipt before saying it has not confirmed. */
const GAS_CLAIM_POLLS = 60

/** The SDK's checked network. Before a claim is sent nothing runs on a network this app could not check; a sent
 *  claim's network check is retried through a node that does not answer, as its receipt reads are. */
async function checkedNetwork(rec: ClaimRecord, ctx: ClaimContext, gen: number): Promise<Network | ClaimRun> {
	for (let poll = 1; ; poll++) {
		try {
			return await ctx.network()
		} catch (e) {
			if (genOf(rec.id) !== gen) return "stop"
			const next = networkUnchecked(rec, e, poll)
			if (next !== "retry") return next
			await wait(RECEIPT_POLL_MS)
			if (genOf(rec.id) !== gen) return "stop"
		}
	}
}

function networkUnchecked(rec: ClaimRecord, e: unknown, poll: number): ClaimRun | "retry" {
	if (!rec.claimTxHash) {
		log("network check failed before any claim", { id: rec.id, error: e instanceof Error ? e.message : String(e) })
		setRuntime(rec.id, { attention: "error", note: UNCHECKED_NETWORK })
		return "stop"
	}
	// A refusal is the network's own answer, shown as any unexpected failure is.
	if (isBridgeError(e)) throw e
	if (poll > RECEIPT_POLLS_PER_ROUND) return closeReceiptRound(rec.id, priorReceiptRounds(rec.id))
	setStep(rec.id, "confirming", `node unreachable — retrying (${poll})`)
	return "retry"
}

/** The claim proper, on the record as it stands after the unseal. */
async function runClaim(id: string, gen: number, mode: ClaimMode, material?: ClaimMaterial): Promise<ClaimRun> {
	const rec = engineRecords().find((r) => r.id === id) as ClaimRecord | undefined
	if (!rec) return "stop" // Cross-tab discard while the unseal signature waited.
	// A fresh run clears any stale note (the 30-min cap, an earlier failure) before it narrates again.
	setRuntime(id, { attention: undefined, note: undefined })
	return claimEnded(id, await claimCall(rec, gen, { target: targetOf(rec), watchOnly: mode.watchOnly, material }))
}

function claimEnded(id: string, result: CallResult): ClaimRun {
	if ("run" in result) return result.run
	if ("outcome" in result) return claimSettled(id, result.outcome)
	return claimStopped(id, result.call, result.error)
}

/** The SDK persisted the completion; this is its side on the card. */
function claimSettled(id: string, outcome: ClaimOutcome): ClaimRun {
	reload()
	const rec = engineRecords().find((r) => r.id === id) as ClaimRecord | undefined
	if (!rec) return "stop"
	finishDeposit(rec)
	if (outcome.gasLeft) flagRecordError(id, gasLeftNote(outcome.gasLeft))
	log("deposit claimed", { id, via: outcome.via })
	return "stop"
}

/** Control first: a stop of the engine's own, a write a guard refused, a watching call that reached a prompt (after
 *  its own tokens landed, the gas claim left for a click). */
function claimStopped(id: string, call: ClaimCall, e: unknown): ClaimRun {
	if (call.stopped) return stopOutcome(id, call.stopped)
	if (isBridgeError(e) && e.code === "persist-failed") return writeRefused(id, e)
	if (isBridgeError(e) && e.code === "needs-prompt") {
		if (call.scene.landed === "claim") flagRecordError(id, GAS_NEEDS_WALLET)
		return "stop"
	}
	const view = claimFailure(e, call.scene)
	if (view.kind === "search") return reportDepositSearch(id, view.search)
	if (view.kind === "run-failure") throw new Error(view.text)
	if (view.clearRounds) receiptRounds.delete(id)
	setRuntime(id, view.runtime)
	return "stop"
}

function stopOutcome(id: string, reason: StopReason): ClaimRun {
	if (reason === "round") return closeReceiptRound(id, priorReceiptRounds(id))
	if (reason === "moved") return "restart"
	if (reason === "ethereum") setRuntime(id, { attention: "error", note: "The Ethereum deposit isn't confirmed yet — retry in a minute." })
	return "stop"
}

/** Another writer moved the record under the claim (a newer claim in another tab, a discard, discovery): the claim
 *  leaves it to its new owner, quietly. Any other storage failure is the run's. */
function writeRefused(id: string, e: BridgeError): ClaimRun {
	if (!(e.cause instanceof RecordDeltaRefused)) throw e.cause ?? e
	log("claim write refused - the record moved", { id, reason: e.cause.reason })
	reload()
	if (engineRecords().some((r) => r.id === id)) setRuntime(id, { attention: undefined, note: undefined, confirmLandedTxHash: undefined })
	return "stop"
}

/**
 * A persisted `claimedByOther` is a claim about the chain, and journal data alone never completes a record: a watching
 * claim reads the token's nullifier first. Automatic resumes use only the material at hand; an explicit click on a
 * private record unseals it (one signature). A marker the chain contradicts is dropped and the run stops; one it
 * confirms settles the record once its gas is settled, and a run that may prompt then claims the gas the other
 * submitter left.
 */
async function verifyClaimedByOther(rec: SendDepositRecord, gen: number, mode: ClaimMode): Promise<ClaimRun> {
	const material = rec.isPrivate ? (cachedMaterial(rec) ?? (await unsealForVerification(rec, mode.interactive))) : undefined
	if (rec.isPrivate ? !material : !publicClaimSecretOf(rec)) return "stop"
	setRuntime(rec.id, { attention: undefined, note: undefined })
	const watched = await claimCall(rec, gen, { target: "token", watchOnly: true, material })
	if (markerDropped(rec.id, watched)) return "stop"
	if (mode.watchOnly || !gasLeftForPrompt(watched)) return claimEnded(rec.id, watched)
	if ((await claimGuards(rec, rec.id)) === "stop") return "stop"
	return claimLeftGas(rec.id, gen, material)
}

/** The gas another submitter's token claim left, claimed through the gas entry, so the click can send no claim but that
 *  one; a watching token call then settles the record. */
async function claimLeftGas(id: string, gen: number, material?: ClaimMaterial): Promise<ClaimRun> {
	const rec = engineRecords().find((r) => r.id === id) as ClaimRecord | undefined
	if (!rec) return "stop"
	const gas = await claimCall(rec, gen, { target: "gas", watchOnly: false, material, landed: true })
	if (!("outcome" in gas)) return claimEnded(id, gas)
	const live = engineRecords().find((r) => r.id === id) as ClaimRecord | undefined
	if (!live) return "stop"
	return claimEnded(id, await claimCall(live, gen, { target: "token", watchOnly: true, material }))
}

/** The chain read the message live and the marker is gone: whatever the watching call met after that, the run ends
 *  there, as an ordinary claim is the record's next step. */
function markerDropped(id: string, result: CallResult): boolean {
	if (!("error" in result) || result.call.stopped || result.call.scene.landed) return false
	const live = currentRecord(id) as ClaimRecord | undefined
	return live !== undefined && live.claimedByOther !== true
}

/** A watching call that confirmed the marker and stopped at the gas the other submitter left. */
function gasLeftForPrompt(result: CallResult): boolean {
	return (
		"error" in result &&
		!result.call.stopped &&
		result.call.scene.landed === "claimed-elsewhere" &&
		isBridgeError(result.error) &&
		result.error.code === "needs-prompt"
	)
}

/** The explicit click on a marked private record unseals it for the verification whatever its
 *  fuel says: a false marker would otherwise hide the ordinary claim that spends that fuel. */
async function unsealForVerification(rec: SendDepositRecord, interactive: boolean): Promise<ClaimMaterial | undefined> {
	if (!interactive || !rec.sealedEnvelope) return undefined
	return (await resolvePrivateClaimMaterial(rec, rec.id)) ?? undefined
}

/** Round bookkeeping: budget the finished round; at the soft cap (NOT a dead-end — no
 *  attention) the card re-arms RETRY and says so. */
function closeReceiptRound(id: string, roundsDone: number): "continue" | "stop" {
	receiptRounds.set(id, roundsDone + 1)
	if (roundsDone + 1 >= RECEIPT_MAX_ROUNDS) {
		setStep(id, undefined, undefined)
		setRuntime(id, {
			note: "Still confirming after ~30 minutes — slow testnet. Press Claim to keep checking; your funds are safe either way.",
		})
		return "stop"
	}
	return "continue"
}

function priorReceiptRounds(id: string): number {
	return receiptRounds.get(id) ?? 0
}

/**
 * The card's "Claim your gas": the bridged gas a token + gas record's tokens left, claimed under the record lock so it
 * never races the record's own claim of it. A record another submitter's claim left open is then finished by a watching
 * claim. Throws the failure for the card to show; a run already holding the record is left to finish it.
 */
export async function runGasClaim(id: string): Promise<void> {
	let failure: unknown
	let finish = false
	const ran = await withRecordLock(
		id,
		async () => {
			const gen = bumpGen(id)
			const rec = engineRecords().find((r) => r.id === id && r.direction === "deposit") as ClaimRecord | undefined
			if (!rec || !deps.claimEntries || !deps.claimContext) return
			const ctx = await deps.claimContext({ recipient: rec.recipient, watchOnly: false })
			const net = await ctx.network().catch(() => {
				throw new Error(UNCHECKED_NETWORK)
			})
			const result = await claimCall(rec, gen, { target: "gas-leg", watchOnly: false }, { ctx, net })
			failure = gasClaimFailure(result)
			reload()
			const live = engineRecords().find((r) => r.id === id) as ClaimRecord | undefined
			finish = "outcome" in result && live?.claimedByOther === true && !claimRetired(live)
		},
		true,
	)
	if (ran === "held-elsewhere") throw new Error("Another tab is claiming this deposit — try again in a moment.")
	if (failure !== undefined) throw new Error(failureText(failure))
	if (finish) await runDepositClaim(id, { interactive: false, watchOnly: true })
}

/** A card gas claim not confirmed within its watch, or dropped, says it may simply be claimed again. */
function gasClaimFailure(result: CallResult): unknown {
	if (!("error" in result)) return undefined
	const dropped = isBridgeError(result.error) && result.error.code === "claim-dropped"
	if (result.call.stopped === "round" || dropped) return new Error(FEE_STOP_COPY["standalone-unconfirmed"])
	return result.call.stopped ? undefined : result.error
}

/** The withdraw consume tail: rediscovered consumeTxHash waits (with identity check) instead of
 *  re-prompting; otherwise the proven-wait → witness → ONE L1 consume runs on the L1 lane. */
export async function runWithdrawConsume(id: string): Promise<void> {
	try {
		await withOperation(() => runWithdrawConsumeInner(id))
	} catch (e) {
		surfaceRunFailure(id, e)
	}
}

async function runWithdrawConsumeInner(id: string): Promise<void> {
	if ((await withRecordLock(id, () => runWithdrawConsumeLocked(id))) === "held-elsewhere") noteHeldElsewhere(id, "finishing this exit")
}

export type ExitRecord = WithdrawJournalRecord | SendWithdrawRecord
type ExitProgress = (p: { provenBlock?: number; targetBlock?: number }) => void

// The consume legs are picked per record shape: a send's exit is consumed on its OWN portal
// clone, so it can never share the single-portal deps the token bridge wired.
const exitConsume = (rec: ExitRecord, onProgress: ExitProgress) =>
	runsAsSend(rec) ? deps.consumeSend?.(rec, onProgress) : deps.consume?.(rec, onProgress)

const exitVerify = (rec: ExitRecord, txHash: string) =>
	runsAsSend(rec) ? deps.verifyConsumeIdentitySend?.(rec, txHash) : deps.verifyConsumeIdentity?.(rec, txHash)

const exitConsumeWired = (rec: ExitRecord): boolean => !!(runsAsSend(rec) ? deps.consumeSend : deps.consume)

/** A rediscovered consumeTxHash waits (with the identity check) instead of re-prompting. */
async function finishSubmittedConsume(rec: ExitRecord, id: string): Promise<void> {
	setStep(id, "verifying", "matching the finish transaction to this withdrawal")
	const legit = (await exitVerify(rec, rec.consumeTxHash as string)) ?? true
	if (!legit) {
		setRuntime(id, {
			attention: "unknown-outcome",
			note: "The recorded finish transaction doesn't match this withdrawal — not marking it done. Your exited funds stay claimable on Ethereum.",
		})
		return
	}
	log("consume already submitted - waiting on it", { id, consumeTxHash: rec.consumeTxHash })
	setStep(id, "confirming", "waiting for the Ethereum confirmation")
	// Read-at-call-time (parity with the original direct call under the caller's dep gate).
	if (await (deps.waitConsumeReceipt as NonNullable<typeof deps.waitConsumeReceipt>)(rec.consumeTxHash as string)) {
		completeWithdraw(rec, rec.consumeTxHash as string)
		return
	}
	patchRecord(id, { consumeTxHash: undefined })
	setRuntime(id, {
		attention: "error",
		note: "The prior finish transaction failed — finish again from this card. Nothing was lost.",
	})
}

/** A send exit can be found on Aztec; a pre-generation one only keeps today's note. */
function recoverExitHash(rec: ExitRecord, id: string): Promise<void> | void {
	return runsAsSend(rec) ? attachExit(rec, id) : reportExitNotRecorded(id)
}

function reportExitNotRecorded(id: string): void {
	setRuntime(id, {
		attention: "unknown-outcome",
		note: "The exit was started but its transaction was never recorded (tab closed mid-send). Check your wallet activity, then discard.",
	})
}

/** Every exit hash and record id the journal holds: an identical earlier exit this browser
 *  recorded is never attached a second time. */
function takenExitHashes(): ReadonlySet<string> {
	const taken = new Set<string>()
	for (const r of engineRecords()) {
		taken.add(r.id)
		if (r.direction === "withdraw" && (r as WithdrawJournalRecord).exitTxHash)
			taken.add((r as WithdrawJournalRecord).exitTxHash as string)
	}
	return taken
}

const EXIT_SNAPSHOT_FIELDS = [
	"id",
	"direction",
	"schema",
	"intent",
	"isPrivate",
	"amount",
	"recipientL1",
	"chainId",
	"portal",
	"bridge",
	"createdAt",
] as const

/** The fields the exit search was verified against; a same-id record another tab rewrote meanwhile
 *  is a different record for the re-key. */
function sameExitSnapshot(live: BridgeJournalRecord, verified: SendWithdrawRecord): boolean {
	const a = live as unknown as Record<string, unknown>
	const b = verified as unknown as Record<string, unknown>
	const token = (live as SendWithdrawRecord).token
	return (
		EXIT_SNAPSHOT_FIELDS.every((k) => a[k] === b[k]) && token?.erc20 === verified.token.erc20 && token?.portal === verified.token.portal
	)
}

/**
 * A send exit that never recorded its transaction: Aztec is searched for the one transaction whose
 * first L2→L1 message is this record's, then the record is re-keyed onto it and consumed inside that
 * hash's lock (`attachAndConsume`). Without a lock API the attach fails closed — two tabs could
 * otherwise both re-key and both consume.
 */
async function attachExit(rec: SendWithdrawRecord, id: string): Promise<void> {
	if (!deps.findExitTx) return reportExitNotRecorded(id)
	if (!deps.locks) {
		setRuntime(id, { attention: "unknown-outcome", note: "Another tab may be finishing this exit — try again in a moment." })
		return
	}
	setStep(id, "verifying", "looking for the exit on Aztec")
	const gen = genOf(id)
	let found: ExitSearch
	try {
		found = await deps.findExitTx(rec, takenExitHashes())
	} catch (e) {
		log("exit search failed", { id, error: e instanceof Error ? e.message : String(e) })
		found = "incomplete"
	}
	if (genOf(id) !== gen) return
	if (typeof found === "string") return reportExitSearch(id, found)
	const next: SendWithdrawRecord = {
		...rec,
		id: found.exitTxHash,
		exitTxHash: found.exitTxHash,
		exitBlock: found.exitBlock,
		updatedAt: Date.now(),
	}
	const outcome = await attachAndConsume(
		id,
		next,
		(live, all) =>
			genOf(id) === gen &&
			sameExitSnapshot(live, rec) &&
			!(live as WithdrawJournalRecord).exitTxHash &&
			!(live as WithdrawJournalRecord).consumeTxHash &&
			!live.completedAt &&
			!all.some((r) => r.id === next.id),
	)
	if (outcome === "held-elsewhere") noteHeldElsewhere(id, "finishing this exit")
	else if (outcome !== "attached") log("exit attach skipped:", { id, outcome })
}

function reportExitSearch(id: string, outcome: "none" | "ambiguous" | "incomplete"): void {
	if (outcome === "none") {
		setRuntime(id, {
			attention: "error",
			note: "No exit for this record was found on Aztec since it was started. If you never confirmed it in your wallet, discard this record.",
		})
	} else if (outcome === "ambiguous") {
		setRuntime(id, {
			attention: "unknown-outcome",
			note: "More than one matching exit was found — not guessing. Keep this record; it can be finished by hand.",
		})
	} else {
		setRuntime(id, { attention: "error", note: "Aztec could not be searched far enough back — try again later." })
	}
}

function noteProveProgress(id: string, p: { provenBlock?: number; targetBlock?: number }): void {
	const rt = runtime.value[id]
	const provenBlock = p.provenBlock ?? rt?.provenBlock
	const targetBlock = p.targetBlock ?? rt?.targetBlock
	const known = provenBlock !== undefined && targetBlock !== undefined
	setRuntime(id, {
		...p,
		proven: known ? provenBlock >= targetBlock : undefined,
		provenFrom: rt?.provenFrom ?? (known && p.provenBlock !== undefined ? p.provenBlock : undefined),
	})
}

/** The lock-held consume sequence: journal-first latch — a fresh consumeTxHash is PERSISTED
 *  before its receipt wait; success completes from a FRESH reread; prior-hash and fresh-hash
 *  receipt failures both clear the hash, each with its own copy. */
async function runWithdrawConsumeLocked(id: string): Promise<void> {
	const rec = engineRecords().find((r) => r.id === id && r.direction === "withdraw") as ExitRecord | undefined
	if (!rec || rec.completedAt) return
	if (!guardBlocked(rec) || !guardDeployment(rec)) return
	if (!exitConsumeWired(rec) || !deps.waitConsumeReceipt) throw new Error("Journal deps not connected")
	// A send's exit spends the record's OWN token block on L1; a block the factory no longer
	// agrees with must never reach the Outbox consume.
	if (runsAsSend(rec) && (await checkTokenBlock(rec.token, id)) === "stop") return

	if (!rec.exitTxHash) return recoverExitHash(rec, id)

	if (rec.consumeTxHash) return finishSubmittedConsume(rec, id)

	setStep(id, "confirming", "waiting for the proven epoch, then one Ethereum confirmation")
	const { consumeTxHash } = (await exitConsume(rec, (p) => noteProveProgress(id, p))) as { consumeTxHash: string }
	patchRecord(id, { consumeTxHash })
	setStep(id, "confirming", "waiting for the Ethereum confirmation")
	if (await deps.waitConsumeReceipt(consumeTxHash)) {
		completeWithdraw(engineRecords().find((r) => r.id === id) as ExitRecord | undefined, consumeTxHash)
	} else {
		patchRecord(id, { consumeTxHash: undefined })
		setRuntime(id, { attention: "error", note: "The finish transaction failed — finish again from this card. Nothing was lost." })
	}
}

/** Whether (and how) a record participates in session resume. "skip" covers completed records,
 *  records neither session-live nor in a prompt-free receipt wait, and mid-flight records the flow
 *  itself is still driving (not resumable yet: a deposit without a leafIndex is between L1 legs, a
 *  withdraw without an exitTxHash is mid-exit-prompt - re-entering them here races the flow, and
 *  would tag a live provisional record unknown-outcome). */
function resumeActionFor(rec: BridgeJournalRecord): "skip" | "deposit" | "withdraw" {
	if (claimRetired(rec)) return "skip"
	// Once a record is KNOWN malformed there is nothing to resume: every run would re-raise the
	// same terminal fault. The first resume after a reload still runs, so the card learns the
	// fault without a click (runtime attention is empty until then); RETRY always reaches it.
	if (runtime.value[rec.id]?.attention === "malformed-record") return "skip"
	if (rec.direction === "deposit" && markerApplies(rec as ClaimRecord)) return claimedByOtherResume(rec as ClaimRecord)
	const promptFreeWait =
		(rec.direction === "deposit" && (rec as DepositJournalRecord).claimTxHash) ||
		(rec.direction === "withdraw" && (rec as WithdrawJournalRecord).consumeTxHash)
	if (!sessionLive.has(rec.id) && !promptFreeWait) return "skip"
	if (rec.direction === "deposit" && !(rec as DepositJournalRecord).leafIndex && !(rec as DepositJournalRecord).claimTxHash) return "skip"
	if (rec.direction === "withdraw" && !(rec as WithdrawJournalRecord).exitTxHash) return "skip"
	return rec.direction === "deposit" ? "deposit" : "withdraw"
}

/** A `claimedByOther` marker is only meaningful on the shape the completion path writes it on: a
 *  claimable record (leaf and message hash known — the verification needs both) with no claim of
 *  its own. Anywhere else — a hash-less record, one with a claim transaction — it is ignored and
 *  the ordinary recovery rules apply. */
function markerApplies(rec: ClaimRecord): boolean {
	return rec.claimedByOther === true && !!rec.leafIndex && !!rec.messageHash && !rec.claimTxHash
}

/** A marked, unfinished record resumes (prompt-free, any session) to be verified: the completion,
 *  the dropped marker, or — without material at hand — nothing. */
function claimedByOtherResume(rec: ClaimRecord): "skip" | "deposit" {
	return claimsThroughHub(rec) && !claimRetired(rec) ? "deposit" : "skip"
}

/** Auto-continue ONLY what this page session initiated, plus prompt-free receipt waits. */
export function resumeSessionWork(): void {
	for (const rec of engineRecords()) {
		const action = resumeActionFor(rec)
		if (action === "deposit") void runDepositClaim(rec.id, { interactive: false })
		else if (action === "withdraw") void runWithdrawConsume(rec.id)
	}
}

/** Every record either key holds, Ethereum-origin first: what every list reads. */
export const listedRecords = computed<AnyJournalRecord[]>(() => [...records.value, ...crossChainRecords.value])

/** Every record except the foregrounded one: while the wizard shows a record's stepper or receipt,
 *  that is its one surface, so no list renders it a second time. Records stay in storage. */
export const visibleRecords = computed(() => listedRecords.value.filter((r) => r.id !== activeFlowId.value))

export function useBridgeJournal() {
	initJournal()
	return {
		records,
		crossChainRecords,
		listedRecords,
		visibleRecords,
		runtime,
		lastCompleted,
		activeFlowId,
		canonicalRecordId,
		claimForeground,
		releaseForeground,
		addRecord,
		addRecordVerified,
		updateRecord,
		discard,
		clearDone,
		markSessionLive,
		isSessionLive,
		cacheSecret,
		runDepositClaim,
		runWithdrawConsume,
		resumeSessionWork,
		deploymentMatches,
	}
}
