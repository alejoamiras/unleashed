import {
	type AnyJournalRecord,
	type BridgeJournalRecord,
	type CrossChainDepositRecord,
	type DepositEnvelopeV2,
	type EncryptionKey,
	type DepositJournalRecord,
	type JournalTokenBlock,
	type KV,
	type SendDepositRecord,
	type SendJournalRecord,
	type SendWithdrawRecord,
	type WithdrawJournalRecord,
	JOURNAL_KEY_PREFIX,
	assetKindOf,
	envelopeMatchesRecord,
	envelopeV3MatchesRecord,
	feeJuiceAddress,
	isCrossChainRecord,
	loadAllRecords,
	loadCrossChainJournal,
	loadJournal,
	openDepositEnvelope,
	openDepositEnvelopeV3,
	patchRecord as journalPatch,
	patchRecordWhen as journalPatchWhen,
	predictPortal,
	pruneCompleted,
	quarantineInvalid,
	recoveryKeyFromSignature,
	recoveryKeyMessage,
	rekeyRecord,
	rekeyRecordWhen,
	removeRecord,
	resealExactEnvelope,
	revokeSealTrust,
	upsertRecord,
} from "@unleashed/bridge-core"
import type { GrantOutcome } from "@/lib/send-model"
import { NETWORK } from "@/lib/network"
import { computed, ref } from "vue"
import { FUEL_PORTAL } from "@/contracts/bridge-generation"
import { SYNC_TARGET_MARGIN_BLOCKS, logPhrase } from "@/lib/bridge-steps"
import { trimTxHash } from "@/lib/format"
import { humanizeWalletError, isUserRejection } from "@/lib/wallet-errors"
import { isWellFormedTxHash } from "@/lib/claim-receipt"
import { isReceiptRecordMismatch } from "@/lib/fuel-claim-state"
import { HELD_ELSEWHERE, type JournalLocks } from "@/lib/journal-locks"
import type { DepositSearch } from "./deposit-reconcile"
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

/** The L1→L2 message isn't consumable until the sequencer folds it into a block AND this wallet's
 *  PXE syncs it; both claim paths revert with one of these wordings until then. This is the NOT-YET
 *  shape ONLY — it must NOT match the already-consumed shape (see isMsgConsumed): upstream 5.0.0
 *  distinguishes them (`No L1 to L2 message found` = not anchored; `No NON-NULLIFIED L1 to L2 message
 *  found` = anchored but nullified), and the two consumers want opposite conditions. `No L1 to L2
 *  message found` is anchored with a word boundary so the "non-nullified" infix can't match here. */
export const isMsgNotReady = (msg: string): boolean =>
	/l1_to_l2_msg_exists|nonexistent L1-to-L2|message not in state|(?<!non-nullified )No L1 to L2 message found/i.test(msg)

/** The already-CONSUMED (nullified) shape: the message was anchored and this claim's nullifier is
 *  already in the tree. 5.0.0's claim oracle checks the nullifier, so a re-claim of consumed FJ
 *  throws `No non-nullified L1 to L2 message found` (@aztec-labs/stdlib l1_to_l2_message). Distinct from
 *  isMsgNotReady — matching that here would (a) treat a not-yet-anchored message as consumed and
 *  latch a false "claimed" [fund-stranding], and (b) never recognise the real consumed shape. */
export const isMsgConsumed = (msg: string): boolean =>
	/No non-nullified L1 to L2 message found|message has already been nullified|L1-to-L2 message is already nullified/i.test(msg)

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

/** Where a hub token deposit's L1→L2 message stands on the checkpointed chain. `invalid` is a proven
 *  wrong identity (the stored message hash is not the one the record's facts describe); `unknown`
 *  is missing evidence (no material, no hash, a failed read) and always means "as today". */
export type MessageState = "nullified" | "live" | "invalid" | "unknown"

/** What finishing an exit on L1 can end in: our own consume transaction, or the discovery that
 *  someone else's already spent the message. */
export type ConsumeOutcome = { consumeTxHash: string } | { consumedByOther: true }

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
	/** Build the claim interaction for a deposit record; returns simulate/send handles. `envelope` is the
	 *  private record's UNSEALED authoritative copy (the fee-juice claim treats `envelope.salt` as the
	 *  recovery source of truth rather than the plaintext journal copy). */
	claim?: (
		rec: DepositJournalRecord,
		secretHex: string,
		envelope?: DepositEnvelopeV2,
	) => Promise<{
		simulate: () => Promise<unknown>
		send: () => Promise<{ txHash: string }>
	}>
	/** Aztec-node receipt lookup. "unreachable" = transport failure - a dead RPC must read as a
	 *  connectivity problem, never as a slow ("pending") claim. */
	claimReceiptStatus?: (txHash: string) => Promise<"success" | "dropped" | "reverted" | "proposed" | "pending" | "unreachable">
	/** Complete a deposit record's L1 leg from its recorded `depositTxHash`: fetch the mined
	 *  receipt, parse the deposit event, and PATCH the record (leafIndex + variant fields).
	 *  "pending" = not mined yet (caller bails softly and retries later); throws on a reverted
	 *  tx or a receipt with no recognizable deposit event. This is what makes an L1-timeout
	 *  stranding recoverable: the flow died after the tx was sent, so only the chain knows how
	 *  the leg ended. */
	recoverDepositLeg?: (rec: DepositJournalRecord) => Promise<"recovered" | "pending">
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
	/** The hub claim for a token-moving schema-3 record. `send` also reports the separate
	 *  registration transaction a private first claim needs. `envelope` is the private record's
	 *  UNSEALED authoritative copy: the fee ladder rebuilds the private fuel secret from
	 *  `envelope.salt`, which the journal's plaintext copy can contradict. */
	claimSend?: (
		rec: SendDepositRecord,
		claimValueHex: string,
		envelope?: DepositEnvelopeV2,
	) => Promise<{
		simulate: () => Promise<unknown>
		send: () => Promise<{ txHash: string; registerTxHash?: string }>
	}>
	/** A schema-3 exit's L1 tail: the consume runs against the record's OWN portal clone, so it
	 *  cannot share the single-portal dep above. `consumedByOther` reports the one outcome that has
	 *  no transaction of ours behind it — the Outbox message was already spent when the consume
	 *  failed, so the funds are out and there is nothing left to send. */
	consumeSend?: (
		rec: SendWithdrawRecord,
		onProgress: (p: { provenBlock?: number; targetBlock?: number }) => void,
	) => Promise<ConsumeOutcome>
	/** The identity check for a rediscovered schema-3 consume tx (its `to` is the token's clone). */
	verifyConsumeIdentitySend?: (rec: SendWithdrawRecord, txHash: string) => Promise<boolean>
	/** Current Aztec block height (latest, not proven) - drives the sync countdown. */
	l2BlockNumber?: () => Promise<number>
	/** 5.0 L1→L2 readiness for a real inbox message key: its checkpoint + the node anchor's current
	 *  checkpoint, or null if the message hasn't folded into the L2 tree yet. The claim is consumable
	 *  only once anchor >= checkpoint (else the claim-simulate throws "No L1 to L2 message found").
	 *  Absent dep / record without a messageHash ⇒ the engine falls back to simulate-only polling. */
	messageReadiness?: (messageHash: string) => Promise<{ checkpoint: number; anchor: number } | null>
	/** Re-pin the wallet's grant set from the tokens the journal still holds. Called whenever a
	 *  record leaves, so a pin never outlives the record that earned it. */
	retainPinnedTokens?: (needed: string[]) => void
	/** Whether a hub token deposit's message is already consumed, read from the message's OWN
	 *  nullifier at `checkpointed` — the journal's settlement floor. The engine hands over the
	 *  material it resolved (the dep lives outside this module and cannot read the secret cache).
	 *  Absent ⇒ "unknown" everywhere: the simulate stays the only consumability authority. */
	messageNullified?: (rec: SendDepositRecord, material: ClaimMaterial) => Promise<MessageState>
	/** Latch `fuel.consumed` from the checkpointed receipt of the record's own fuel-spending
	 *  transaction, when it has one. The claim build does this on its way to the hub; a completion
	 *  that never builds a claim must ask for it. */
	reconcileFuel?: (id: string) => Promise<void>
	/** Find the router transaction of a hub token deposit that never recorded its hash, verified
	 *  against calldata and receipt on L1. Absent ⇒ a hash-less record stays where it is, as before. */
	findDepositTx?: (rec: SendDepositRecord) => Promise<DepositSearch>
	/** Find (and re-read) the exit transaction of a send exit that never recorded its hash: the one
	 *  transaction in the window whose FIRST L2→L1 message is the record's, excluding `taken` (every
	 *  hash and id the journal already holds). Absent ⇒ the record keeps today's note. */
	findExitTx?: (rec: SendWithdrawRecord, taken: ReadonlySet<string>) => Promise<ExitSearch>
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
const inFlight = new Set<string>()
const secretCache = new Map<string, { secretHex: string; envelope: DepositEnvelopeV2 }>()
// Set ONLY when THIS process passed the sync gate and dispatched the claim send - the
// forge-resistant provenance that scopes deposit auto-hide. Deliberately NOT sessionLive.
const localClaimProvenance = new Set<string>()
// Per-record generation token - every fresh runner entry and every discard bumps it, so a
// chunked receipt round scheduled before the bump exits silently instead of racing the new owner.
const generations = new Map<string, number>()
// Cumulative exhausted receipt rounds per record (caps the ~30-min soft wait).
const receiptRounds = new Map<string, number>()

function bumpGen(id: string): number {
	const next = (generations.get(id) ?? 0) + 1
	generations.set(id, next)
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
	records.value = loadJournal(deps.kv)
	crossChainRecords.value = loadCrossChainJournal(deps.kv)
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

function observedHashes(rec: BridgeJournalRecord | undefined): { key: string; name: string; hash: string }[] {
	const fields: Partial<Record<HashLeg, unknown>> = rec ?? {}
	return HASH_LEGS.flatMap(([leg, name]) => {
		const hash = fields[leg]
		return typeof hash === "string" && TX_HASH.test(hash) ? [{ key: `${leg}:${hash.toLowerCase()}`, name, hash }] : []
	})
}

/** The runtime patch appending `text` to a record's log; a log that starts here seeds its seen hashes. */
function logPatch(id: string, text: string): Pick<RecordRuntime, "log"> {
	const rows = runtime.value[id]?.log
	if (!rows) loggedHashes.set(id, new Set(observedHashes(engineRecords().find((r) => r.id === id)).map((h) => h.key)))
	logSeq += 1
	return { log: [...(rows ?? []), { seq: logSeq, at: deps.now(), text }].slice(-LOG_CAP) }
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
	return logPatch(id, logPhrase(step, rec))
}

function logNewHashes(): void {
	for (const rec of engineRecords()) {
		const seen = runtime.value[rec.id]?.log ? loggedHashes.get(rec.id) : undefined
		if (!seen) continue
		for (const { key, name, hash } of observedHashes(rec)) {
			if (seen.has(key)) continue
			seen.add(key)
			loggedSteps.delete(rec.id)
			// Observed, never "sent" or "confirmed": another tab's write reaches this through the same reload.
			setRuntime(rec.id, logPatch(rec.id, `${name} hash observed · ${trimTxHash(safeAddressText(hash))}`))
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

export function addRecord(rec: BridgeJournalRecord): void {
	upsertRecord(deps.kv, rec)
	reload()
}

/** Write-and-verify: a private deposit's record must be durably stored BEFORE the irreversible
 *  L1 tx - a storage failure here aborts the flow instead of proceeding into stranding. */
export function addRecordVerified(rec: BridgeJournalRecord): void {
	upsertRecord(deps.kv, rec)
	const readBack = loadJournal(deps.kv).find((r) => r.id === rec.id)
	if (!readBack) throw new Error("Could not persist the bridge record — aborting before the deposit (storage full?).")
	reload()
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
	return loadAllRecords(deps.kv).find((r) => r.id === id) as BridgeJournalRecord | undefined
}

/** Journal first for a cross-chain deposit: written under its own key and read back before any
 *  source-chain signature, so a failed write aborts instead of stranding the claim material. */
export function addCrossChainRecordVerified(rec: CrossChainDepositRecord): void {
	upsertRecord(deps.kv, rec)
	if (!loadCrossChainJournal(deps.kv).some((r) => r.id === rec.id)) {
		throw new Error("Could not persist the bridge record — aborting before the deposit (storage full?).")
	}
	reload()
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

export function discard(id: string): void {
	bumpGen(id) // Any in-flight chunked round dies at its next generation check.
	releaseForeground(id) // A discarded record can never be a valid takeover (CAS - only if it owns it).
	removeRecord(deps.kv, id)
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
	reload()
	// Re-derived from what SURVIVED, never from the record that left: two records can share a token.
	deps.retainPinnedTokens?.(sendTokenBlocks().map((t) => t.l2Token))
	log("discarded", id)
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
 * A cross-chain record seals a v3 amount window until its deposit lands. Opened with the key in hand, it
 * is re-sealed exact against the deposited amount, so every later open reads an ordinary v2 envelope.
 * Null when the deposit is not known yet or falls outside the sealed window.
 */
export async function openClaimEnvelope(key: EncryptionKey, rec: ClaimRecord, blob: string): Promise<DepositEnvelopeV2 | null> {
	if (!isCrossChainRecord(rec as AnyJournalRecord)) return openDepositEnvelope(key, blob)
	const v3 = await openDepositEnvelopeV3(key, blob).catch(() => null)
	if (!v3) return openDepositEnvelope(key, blob)
	if (!rec.leafIndex || !envelopeV3MatchesRecord(v3, rec)) return null
	const deposited = { recipient: rec.recipient, amount: rec.amount, leafIndex: rec.leafIndex }
	patchRecord(rec.id, { sealedEnvelope: await resealExactEnvelope(key, v3, deposited) })
	return { v: 2, secret: v3.secret, sealerL1: v3.sealerL1, ...deposited, ...(v3.salt ? { salt: v3.salt } : {}) }
}

const OUTSIDE_SEALED_WINDOW = "This deposit doesn't match its sealed copy, so it can't be claimed from here. Nothing was deleted."

async function resolvePrivateSecret(rec: ClaimRecord): Promise<{ secretHex: string; envelope: DepositEnvelopeV2 } | null> {
	const cached = secretCache.get(rec.id)
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
		patchRecord(rec.id, { recipient: envelope.recipient, amount: envelope.amount, leafIndex: envelope.leafIndex ?? rec.leafIndex })
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
 *  a runner another tab holds is skipped exactly like an in-flight duplicate here. */
async function withRecordLock(id: string, fn: () => Promise<void>): Promise<"ran" | "held-local" | "held-elsewhere"> {
	if (inFlight.has(id)) {
		log("already in flight - skipping duplicate", id)
		return "held-local"
	}
	// Local ownership is taken BEFORE the lock request: the grant is asynchronous, and two immediate
	// starts in one tab would otherwise both reach it, the loser reading as another tab's runner.
	inFlight.add(id)
	try {
		if (!deps.locks) {
			await runRecordBody(id, fn)
			return "ran"
		}
		const outcome = await deps.locks.record(id, () => runRecordBody(id, fn))
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
function underJournalLock<T>(fn: () => T): Promise<T> {
	return deps.locks ? deps.locks.journal(fn) : Promise.resolve().then(fn)
}

function completeDeposit(rec: ClaimRecord | undefined): void {
	// Cross-tab guard: another tab may have discarded (record gone) or completed this record while
	// we ran - generations are tab-local, so the WRITE must be existence- and idempotency-checked.
	if (!rec) return
	const current = engineRecords().find((r) => r.id === rec.id)
	if (!current || current.completedAt) return
	patchRecord(rec.id, { completedAt: deps.now() })
	finishDeposit(rec)
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
 * The deposit claim tail: guards → secret resolution → sync-gate → ONE send → receipt-anchored,
 * identity-checked completion. Explicit-click only for rediscovered records; the deposit flow
 * calls it directly for sessionLive ones.
 */
export async function runDepositClaim(id: string, opts: { interactive?: boolean } = {}): Promise<void> {
	try {
		// withOperation wraps EACH spawned continuation (this is the single entry point for card
		// retries, resumeSessionWork, and the fuel claim leg) — never the void dispatcher, which
		// would release the switch gate immediately.
		await withOperation(() => runDepositClaimInner(id, opts))
	} catch (e) {
		surfaceRunFailure(id, e)
	}
}

/** Failures from the run entrypoints land on the RECORD (every UI call site voids the promise). */
function surfaceRunFailure(id: string, e: unknown): void {
	const msg = humanizeWalletError(e instanceof Error ? e.message : String(e))
	log("run failed:", id, msg)
	if (!engineRecords().some((r) => r.id === id)) return
	setRuntime(id, { attention: "error", note: `${msg}. Your funds are not lost — retry from this card.` })
}

async function runDepositClaimInner(id: string, opts: { interactive?: boolean } = {}): Promise<void> {
	const interactive = opts.interactive !== false
	let continueRounds = false
	let gen = 0
	const ran = await withRecordLock(id, async () => {
		// This runner is now the record's owner - any previously scheduled round dies silently.
		gen = bumpGen(id)
		continueRounds = (await runDepositClaimLocked(id, gen, interactive)) === "continue"
	})
	if (ran === "held-elsewhere") noteHeldElsewhere(id, "claiming this deposit")
	// Chunked re-entry happens OUTSIDE the lock so RETRY/DISCARD stay reachable between rounds.
	if (continueRounds && genOf(id) === gen) {
		await wait(INTER_ROUND_MS)
		if (genOf(id) === gen) void runDepositClaim(id, { interactive: false })
	}
}

/** The lock-held claim sequence. Runs UNDER withRecordLock's serialization — the awaits in
 *  here are deliberately unfenced (a newer runner cannot enter until this releases; its
 *  bumpGen then kills this runner's rounds); explicit gen checks live only in the receipt
 *  polling and the caller's chunked re-entry. Returns whether another receipt round should
 *  be scheduled outside the lock. */
async function runDepositClaimLocked(id: string, gen: number, interactive: boolean): Promise<"continue" | "stop"> {
	const rec = claimTarget(id)
	if (!rec) return "stop"

	if (rec.claimTxHash !== undefined && !isWellFormedTxHash(rec.claimTxHash)) return reportMalformedClaimHash(rec.id)
	if (claimsThroughHub(rec) && markerApplies(rec)) return revalidateClaimedByOther(rec, gen, interactive)
	if ((await claimGuards(rec, id)) === "stop") return "stop"
	if (rec.claimTxHash) return resumeSentClaim(rec, id, gen, interactive)
	// Caller-side condition so the common has-leaf path stays synchronous (no new await seam).
	if (legRecoveryNeeded(rec) && (await recoverLegIfNeeded(rec, id)) === "stop") return "stop"

	const start = await resolveClaimStart(rec, id, gen)
	if (start === "stop") return "stop"
	const { fresh, material } = start
	// Interaction CONSTRUCTION happens BEFORE all three gates — fee/fuel resolution timing and
	// any journal mutations the build performs must not move.
	const interaction = await buildClaimHandles(fresh, material)

	// A retry on an already-gate-passed record must NOT visually re-run the crossing: narrate the
	// quick revalidation under the CLAIM phase instead (the simulate still guards consumability).
	const preGated = runtime.value[id]?.claimable === true
	let gate: ArrivalGateState = { simulateStart: 0, counted: false, preGated }
	// Await each gate only when IT can actually run: a preGated retry, a missing dep, a
	// snapshot-less or keyless record must reach the next stage with the same synchronous
	// flow the original had (no no-op await seams — each gate is guarded independently).
	if (!preGated && countdownApplies(fresh)) gate = await awaitBlockCountdown(fresh, id, gate)
	if (!preGated && checkpointApplies(fresh)) gate = await awaitCheckpointGate(fresh, id, gate)
	const ready = await awaitConsumable(interaction, fresh, material, gate)
	if ((await settleConsumability(ready, fresh, gen)) === "stop") return "stop"
	setRuntime(id, { claimable: true })

	return sendAndWatch(id, gen, interaction)
}

/** The pre-build stretch: the claim material, the cross-tab reread, and the nullifier read — which
 *  comes BEFORE any fee construction, because a message someone else already spent needs no fee
 *  ladder, no simulate and no wallet prompt. "stop" = the run ended here (narrated or completed). */
async function resolveClaimStart(
	rec: ClaimRecord,
	id: string,
	gen: number,
): Promise<{ fresh: ClaimRecord; material: ClaimMaterial } | "stop"> {
	const material = rec.isPrivate ? await resolvePrivateClaimMaterial(rec, id) : resolvePublicClaimMaterial(rec, id)
	if (!material) return "stop"
	setRuntime(id, { attention: undefined, note: undefined })

	const fresh = engineRecords().find((r) => r.id === id) as ClaimRecord | undefined
	if (!fresh) return "stop" // Cross-tab discard while the unseal signature waited.
	const probe = await probeClaimedElsewhere(fresh, material)
	// The read awaited too: the record may have been discarded or replaced meanwhile — read from
	// storage, since another tab's write reaches the reactive copy only with its storage event.
	if (genOf(id) !== gen) return "stop"
	const stored = currentRecord(id)
	if (!stored || !sameClaimSnapshot(stored, fresh)) return "stop"
	if (probe === "invalid") return reportTamperedMessage(id)
	if (probe === "nullified" && claimsThroughHub(fresh)) return completeClaimedByOther(fresh, gen)
	return { fresh, material }
}

async function settleConsumability(
	ready: Awaited<ReturnType<typeof awaitConsumable>>,
	fresh: ClaimRecord,
	gen: number,
): Promise<"proceed" | "stop"> {
	if (ready === "ready") return "proceed"
	if (ready === "invalid") return reportTamperedMessage(fresh.id)
	if (ready === "claimed-elsewhere" && claimsThroughHub(fresh)) return completeClaimedByOther(fresh, gen)
	throw new Error("the L1→L2 message never became consumable — claim it again from the journal later")
}

/** A persisted claim hash the node cannot be asked about is a RECORD problem (corrupted or
 *  hand-edited storage), not a receipt state: the receipt dep would read the parse throw as
 *  "unreachable", the round would narrate connectivity, and after the cap the card would say
 *  "slow testnet" while every retry repeated. Terminal: only a restore or a discard fixes it. */
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
	if (!rec || rec.completedAt) return undefined
	if (crossChainUnclaimable(rec)) return undefined
	if (!guardBlocked(rec) || !guardDeployment(rec)) return undefined
	if (!claimsThroughHub(rec) && !deps.claim) throw new Error("Journal deps not connected")
	if (claimsThroughHub(rec) && !deps.claimSend) throw new Error("Journal deps not connected")
	if (!deps.claimReceiptStatus) throw new Error("Journal deps not connected")
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
 *  its wallet grant — both BEFORE any interaction is built or any transaction is signed. */
async function claimGuards(rec: ClaimRecord, id: string): Promise<"stop" | "proceed"> {
	if (recipientMismatch(rec, id)) return "stop"
	return runsAsSend(rec) ? prepareSendLane(rec, id) : "proceed"
}

/** The claim's simulate/send pair: a token-moving send claims through the hub (which may also
 *  register the token), everything else through the token-bridge dep. */
async function buildClaimHandles(
	rec: ClaimRecord,
	material: { secretHex: string; envelope?: DepositEnvelopeV2 },
): Promise<{ simulate: () => Promise<unknown>; send: () => Promise<{ txHash: string; registerTxHash?: string }> }> {
	if (claimsThroughHub(rec)) {
		if (!deps.claimSend) throw new Error("Journal deps not connected")
		return deps.claimSend(rec, material.secretHex, material.envelope)
	}
	return (deps.claim as NonNullable<typeof deps.claim>)(rec as DepositJournalRecord, material.secretHex, material.envelope)
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

/** An already-sent claim is finished by waiting on ITS receipt, never a re-send. A checkpointed
 *  receipt IS confirmation; the message probe (best-effort, needs the secret - an EXPLICIT
 *  click on a rediscovered private record unseals it first) can only DELAY completion while
 *  the PXE still shows the message as claimable. */
async function resumeSentClaim(rec: ClaimRecord, id: string, gen: number, interactive: boolean): Promise<"continue" | "stop"> {
	if (rec.isPrivate && interactive && !secretCache.has(id) && rec.sealedEnvelope) {
		const resolved = await resolvePrivateSecret(rec)
		if (!resolved) return "stop"
	}
	// A fresh re-entry clears any stale soft note (the 30-min cap) before checking again.
	setRuntime(id, { attention: undefined, note: undefined })
	return (await runReceiptRound(rec, gen)) === "continue" ? "continue" : "stop"
}

/**
 * No leafIndex ⇒ the deposit leg hasn't finished. With a recorded depositTxHash the leg is
 * chain-recoverable from the mined receipt; without one, a hub token send is first looked for
 * on Ethereum (`reconcileDepositLeg`), and every other shape waits for the flow that owns it.
 * A fueled record whose EVENT-DERIVED fuel fields are missing is chain-recoverable by the same
 * receipt, but the gate above only ever fired on a missing TOKEN leaf — so those records never
 * got rehydrated. They must, because the private ladder now fails closed without them rather
 * than silently falling through to the public one. Guarded on the dep + tx hash so the bail
 * below stays reachable only from the original missing-leaf path.
 */
function legRecoveryNeeded(rec: ClaimRecord): boolean {
	// A send that bought gas emits the same router event, so its fuel fields come back the same way.
	const boughtGas = rec.schema === 2 || (runsAsSend(rec) && rec.intent === "token+gas")
	const fuelFieldsRecoverable =
		boughtGas && !!rec.depositTxHash && !!deps.recoverDepositLeg && (!rec.fuel?.received || !rec.fuel?.leafIndex)
	return !rec.leafIndex || fuelFieldsRecoverable
}

async function recoverLegIfNeeded(rec: ClaimRecord, id: string): Promise<"proceed" | "stop"> {
	let target = rec
	if (!target.depositTxHash) {
		if ((await reconcileDepositLeg(target, id)) === "stop") return "stop"
		// The hash was just written (by this tab or another): the leg recovery reads the live record.
		const live = engineRecords().find((r) => r.id === id) as ClaimRecord | undefined
		if (!live?.depositTxHash) return "stop"
		target = live
	}
	if (!deps.recoverDepositLeg) {
		log("no leafIndex yet - the deposit leg is still running", id)
		return "stop"
	}
	if ((await attemptLegRecovery(target, id)) === "stop") return "stop"
	return "proceed"
}

/** Ethereum decides what a hash-less hub token record's deposit is. The verified hash is written
 *  once, under the journal lock, only onto the record the search verified and only while it has no
 *  hash; a different hash another tab wrote meanwhile is kept for that tab's own run — the leg
 *  recovery reads a receipt without checking whose call it was, so only the verified hash proceeds. */
async function reconcileDepositLeg(rec: ClaimRecord, id: string): Promise<"proceed" | "stop"> {
	if (!claimsThroughHub(rec) || !deps.findDepositTx) {
		log("no leafIndex yet - the deposit leg is still running", id)
		return "stop"
	}
	setStep(id, "depositing", "looking for the deposit on Ethereum")
	const gen = genOf(id)
	let result: DepositSearch
	try {
		result = await deps.findDepositTx(rec)
	} catch (e) {
		log("deposit search failed", { id, error: e instanceof Error ? e.message : String(e) })
		result = "incomplete"
	}
	if (genOf(id) !== gen) return "stop"
	if (typeof result === "string") return reportDepositSearch(id, result)
	const { txHash } = result
	const written = await underJournalLock(() =>
		genOf(id) === gen
			? journalPatchWhen(deps.kv, id, (live) => sameDepositSnapshot(live, rec) && !(live as ClaimRecord).depositTxHash, {
					depositTxHash: txHash,
				})
			: undefined,
	)
	reload()
	if (genOf(id) !== gen) return "stop"
	if (written) {
		log("deposit found on Ethereum", { id, txHash })
		return "proceed"
	}
	const live = engineRecords().find((r) => r.id === id) as ClaimRecord | undefined
	if (live?.depositTxHash === txHash && sameDepositSnapshot(live, rec)) return "proceed" // another tab wrote the same hash first
	log("reconcile write skipped - the record moved or carries another hash", id)
	return "stop"
}

function reportDepositSearch(id: string, outcome: "none" | "ambiguous" | "incomplete"): "stop" {
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

/** The claim snapshot plus everything the L1 match was verified against: the token, the fuel's
 *  amounts and secret hash, and the record's own start time (the search window). */
function sameDepositSnapshot(live: BridgeJournalRecord, verified: ClaimRecord): boolean {
	if (!sameClaimSnapshot(live, verified) || live.completedAt) return false
	const a = live as SendDepositRecord
	const b = verified as SendDepositRecord
	return (
		a.createdAt === b.createdAt &&
		a.token?.erc20 === b.token?.erc20 &&
		a.fuel?.amount === b.fuel?.amount &&
		a.fuel?.minOutput === b.fuel?.minOutput &&
		a.fuel?.secretHashHex === b.fuel?.secretHashHex &&
		a.fuel?.fpc === b.fuel?.fpc
	)
}

/** One recovery attempt against the recorded L1 receipt: terminal receipt-mismatch vs
 *  retryable error classification, and the not-yet-mined soft bail. */
async function attemptLegRecovery(rec: ClaimRecord, id: string): Promise<"recovered" | "stop"> {
	setStep(id, "depositing", "checking the Ethereum deposit")
	let outcome: "recovered" | "pending"
	try {
		// Read-at-call-time (parity): a concurrently removed dep throws into THIS catch, exactly
		// like the original property access did.
		outcome = await (deps.recoverDepositLeg as NonNullable<typeof deps.recoverDepositLeg>)(rec as DepositJournalRecord)
	} catch (e) {
		const raw = e instanceof Error ? e.message : String(e)
		setRuntime(id, { attention: isReceiptRecordMismatch(raw) ? "receipt-mismatch" : "error", note: humanizeWalletError(raw) })
		return "stop"
	}
	if (outcome === "pending") {
		setStep(id, "depositing", "waiting for the Ethereum confirmation")
		setRuntime(id, { attention: "error", note: "The Ethereum deposit isn't confirmed yet — retry in a minute." })
		return "stop"
	}
	log("deposit leg recovered from L1", id)
	setRuntime(id, { attention: undefined, note: undefined })
	return "recovered"
}

/** The claim material: for a private record the unsealed authoritative copy — forwarded to
 *  the claim dep so the fee-juice path reads `envelope.salt` (source of truth) over the
 *  plaintext journal copy. Null = the run must stop (already narrated). */
async function resolvePrivateClaimMaterial(
	rec: ClaimRecord,
	id: string,
): Promise<{ secretHex: string; envelope?: DepositEnvelopeV2 } | null> {
	// Only narrate UNSEALING when a real signature is needed (a rediscovered record). A fresh
	// in-session deposit has its secret cached, so the unseal is instant - setting "unsealing"
	// (which the rail maps to CLAIM) flashes CLAIM and then regresses to CROSSING when the sync
	// gate below runs (the "instant green then rollback" bug). Cached ⇒ stay quiet; the gate
	// narrates CROSSING until the simulate probe says the message is consumable.
	if (!secretCache.has(id)) setStep(id, "unsealing", "one Ethereum signature")
	const resolved = await resolvePrivateSecret(rec)
	if (!resolved) return null
	return { secretHex: resolved.secretHex, envelope: resolved.envelope }
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

function resolvePublicClaimMaterial(rec: ClaimRecord, id: string): { secretHex: string; envelope?: DepositEnvelopeV2 } | null {
	const secretHex = publicClaimSecretOf(rec)
	if (!secretHex) {
		setRuntime(id, { attention: "stale", note: "This record has no claim secret — it cannot be claimed." })
		return null
	}
	return { secretHex }
}

/** Whether the block countdown has anything to do for this record. */
function countdownApplies(rec: ClaimRecord): boolean {
	return rec.depositL2Block !== undefined && !!deps.l2BlockNumber
}

/** Whether the checkpoint gate has anything to do for this record. */
function checkpointApplies(rec: ClaimRecord): boolean {
	return !!deps.messageReadiness && (!!rec.messageHash || !!rec.fuel?.messageHash)
}

/** The arrival gates' threaded state: `simulateStart` is the shared 300-iteration budget the
 *  countdown consumes from ahead of the simulate loop; `counted` selects the later
 *  "message arrived" narration once any gate actually waited. */
interface ArrivalGateState {
	simulateStart: number
	counted: boolean
	preGated: boolean
}

/** Sync leg 1 — block countdown (display pacing): the deposit-time L2 snapshot + a fixed
 *  margin gives a LEGIBLE "blocks until arrival" - no PXE simulate churn while the rollup
 *  predictably catches up. Best-effort: missing snapshot/dep/node falls through to the gate.
 *  Never an authority — it can never green-light a claim by itself. */
async function awaitBlockCountdown(rec: ClaimRecord, id: string, gate: ArrivalGateState): Promise<ArrivalGateState> {
	let { simulateStart: i, counted } = gate
	const target = rec.depositL2Block !== undefined && deps.l2BlockNumber ? rec.depositL2Block + SYNC_TARGET_MARGIN_BLOCKS : null
	if (target !== null && deps.l2BlockNumber) {
		while (i < 300) {
			let current: number
			try {
				current = await deps.l2BlockNumber()
			} catch {
				break // Connectivity wobble: the gate loop narrates from here.
			}
			if (current >= target) {
				setRuntime(id, { syncBlock: current })
				break
			}
			counted = true
			setRuntime(id, { syncBlock: current })
			const left = target - current
			setStep(id, "syncing", `${left} ${left === 1 ? "block" : "blocks"} until your funds arrive`)
			await wait(6000)
			i++
		}
	}
	return { ...gate, simulateStart: i, counted }
}

/** Sync leg 2 — the 5.0 checkpoint gate, the consumability pre-check for records that captured
 *  the real inbox message key(s). An L1→L2 message is claimable only once the node anchor's
 *  checkpoint >= the message's checkpoint (the claim builds its membership witness against the
 *  anchor; before that the claim-simulate throws "No L1 to L2 message found"). We poll the REAL
 *  keys the inbox emitted — the token claim AND, for a fueled deposit, the FJ message that pays
 *  for it. Records with no messageHash fall through to the simulate-only loop. Its own
 *  separate 300 budget; waiting here sets `counted`. */
async function awaitCheckpointGate(rec: ClaimRecord, id: string, gate: ArrivalGateState): Promise<ArrivalGateState> {
	let counted = gate.counted
	const gateHashes = [rec.messageHash, rec.fuel?.messageHash].filter((h): h is string => !!h)
	if (deps.messageReadiness && gateHashes.length > 0) {
		let fresh = true
		for (let g = 0; g < 300; g++) {
			const blocked = await sweepMessageCheckpoints(gateHashes)
			if (blocked === null) {
				markCheckpointsPassed(id)
				break
			}
			counted = true
			if (blocked === "unfolded") setStep(id, "syncing", "waiting for the message to reach the L2")
			else {
				narrateCheckpointsLeft(id, Math.max(blocked.checkpoint - blocked.anchor, 0), fresh)
				fresh = false
			}
			await wait(6000)
		}
	}
	return { ...gate, counted }
}

/** The sweep reports only blocked messages, so a counted wait would otherwise end one short of full. */
function markCheckpointsPassed(id: string): void {
	if (runtime.value[id]?.checkpointSpan) setRuntime(id, { checkpointsLeft: 0 })
}

/** The count also feeds the rail's crossing fraction, against the attempt's first reading. A lagging
 *  node can report a receding anchor, so within one attempt the count shown only falls. The first
 *  reading replaces a previous attempt's count in place, so the rail never drops to no count. */
function narrateCheckpointsLeft(id: string, reported: number, first: boolean): void {
	const prev = first ? undefined : runtime.value[id]
	const left = Math.min(prev?.checkpointsLeft ?? reported, reported)
	setRuntime(id, { checkpointsLeft: left, checkpointSpan: prev?.checkpointSpan ?? left })
	setStep(id, "syncing", `${left} ${left === 1 ? "checkpoint" : "checkpoints"} until your funds arrive`)
}

/** One sweep over the gate hashes: the FIRST not-yet-ready message blocks the sweep — either
 *  "unfolded" (probe failed / message not anchored) or its checkpoint distance. Null = all ready. */
async function sweepMessageCheckpoints(gateHashes: string[]): Promise<{ checkpoint: number; anchor: number } | "unfolded" | null> {
	for (const h of gateHashes) {
		// Read-at-call-time (parity): the caller gates on the dep; a concurrent removal throws
		// out of the gate loop exactly like the original direct call.
		const st = await (deps.messageReadiness as NonNullable<typeof deps.messageReadiness>)(h).catch(() => null)
		if (st === null) return "unfolded"
		if (st.anchor < st.checkpoint) return st
	}
	return null
}

/** The claim-simulate loop — the consumability AUTHORITY. Shares the countdown's 300-iteration
 *  budget (`simulateStart` is how many the countdown consumed). Only a record already
 *  known-claimable (preGated - a retry within the same session) narrates under CLAIM up front;
 *  a FRESH claim stays on CROSSING until a probe actually says the message is consumable: an
 *  optimistic CLAIM would regress to CROSSING on the first not-ready answer. Reload of an already-ready record shows one brief
 *  CROSSING tick before CLAIM - forward, and the ready-simulate returns immediately, so no 6s
 *  stall. */
async function awaitConsumable(
	interaction: { simulate: () => Promise<unknown> },
	rec: ClaimRecord,
	material: ClaimMaterial,
	gate: ArrivalGateState,
): Promise<"ready" | "claimed-elsewhere" | "invalid" | "timeout"> {
	const id = rec.id
	for (let i = gate.simulateStart; i < 300; i++) {
		narrateConsumableWait(id, gate)
		try {
			await interaction.simulate()
			return "ready"
		} catch (e) {
			const verdict = await classifyConsumable(e, rec, material)
			if (verdict === "error") throw e
			if (verdict !== "not-ready") return verdict
			log(`message not consumable yet (poll ${i + 1}) - waiting 6s`, id)
			await wait(6000)
		}
	}
	return "timeout"
}

function narrateConsumableWait(id: string, gate: ArrivalGateState): void {
	if (gate.preGated) setStep(id, "sending", "checking the message")
	else
		setStep(
			id,
			"syncing",
			gate.counted ? "message arrived — waiting for your wallet to sync it" : "waiting for your wallet to sync the message",
		)
}

/** A simulate failure sorted: not-yet-anchored keeps polling; a consumed-shaped error is "claimed
 *  elsewhere" only once the chain's nullifier agrees (the simulate speaks for the wallet's view,
 *  the nullifier for the chain) — every other case is today's error. */
async function classifyConsumable(
	e: unknown,
	rec: ClaimRecord,
	material: ClaimMaterial,
): Promise<"not-ready" | "claimed-elsewhere" | "invalid" | "error"> {
	const msg = e instanceof Error ? e.message : String(e)
	if (isMsgNotReady(msg)) return "not-ready"
	if (!isMsgConsumed(msg)) return "error"
	const probe = await probeClaimedElsewhere(rec, material)
	if (probe === "nullified") return "claimed-elsewhere"
	if (probe === "invalid") return "invalid"
	return "error"
}

/** The nullifier read for a hub token claim. Any other shape, an unwired dep or a failed read is
 *  "unknown" — the path the engine took before the read existed. */
async function probeClaimedElsewhere(rec: ClaimRecord, material: ClaimMaterial): Promise<MessageState> {
	if (!claimsThroughHub(rec) || !deps.messageNullified) return "unknown"
	try {
		return await deps.messageNullified(rec, material)
	} catch (e) {
		log("nullifier read failed - treating the message as unknown", { id: rec.id, error: e instanceof Error ? e.message : String(e) })
		return "unknown"
	}
}

function reportTamperedMessage(id: string): "stop" {
	setRuntime(id, {
		attention: "tampered",
		note: "This record's message doesn't match its stored details — nothing was claimed. Restore the record from a backup, or discard it.",
	})
	return "stop"
}

/** The fields a claimed-by-another completion must find unchanged: another tab can replace a
 *  same-id record while the nullifier read awaits, and `completeDeposit`'s existence check would
 *  not notice. */
const CLAIM_SNAPSHOT_FIELDS = [
	"id",
	"direction",
	"schema",
	"intent",
	"isPrivate",
	"amount",
	"recipient",
	"secretHashHex",
	"leafIndex",
	"messageHash",
	"chainId",
	"portal",
	"bridge",
] as const

function sameClaimSnapshot(live: BridgeJournalRecord, verified: ClaimRecord): boolean {
	const a = live as unknown as Record<string, unknown>
	const b = verified as unknown as Record<string, unknown>
	return CLAIM_SNAPSHOT_FIELDS.every((k) => a[k] === b[k])
}

/** The token's nullifier says nothing about the fuel: a relayer can claim the token with its own
 *  fees and leave this record's fuel unclaimed. */
function fuelSettledFor(rec: SendDepositRecord): boolean {
	return rec.intent !== "token+gas" || rec.fuel?.consumed === true || rec.fuel?.standaloneClaimed === true
}

/** The fuel a completion is about: a same-id record whose fuel block or sealed copy was replaced
 *  while a read awaited is a different record for this purpose. */
function sameFuelIdentity(live: BridgeJournalRecord, verified: SendDepositRecord): boolean {
	const a = live as SendDepositRecord
	return (
		a.sealedEnvelope === verified.sealedEnvelope &&
		a.registerTxHash === verified.registerTxHash &&
		a.fuel?.secretHashHex === verified.fuel?.secretHashHex &&
		a.fuel?.claimTxHash === verified.fuel?.claimTxHash
	)
}

/** The fuel identity plus the settlement flags the decision was made on. */
function sameFuelState(live: BridgeJournalRecord, verified: SendDepositRecord): boolean {
	const a = live as SendDepositRecord
	return (
		sameFuelIdentity(live, verified) &&
		a.fuel?.consumed === verified.fuel?.consumed &&
		a.fuel?.standaloneClaimed === verified.fuel?.standaloneClaimed
	)
}

/**
 * Another submitter's claim is DONE for the token: the message named this record's recipient. The
 * record completes only once its fuel is settled too — a public leg stays open for the standalone
 * gas claim, a private one stays open with its sealed material (private gas is spent only as this
 * account's own claim fee). Settlement is decided on the record as re-read after the fuel receipt
 * reconciliation, and the write requires that exact claim + fuel snapshot, no claim hash, no
 * completion, and this runner's generation.
 */
async function completeClaimedByOther(captured: SendDepositRecord, gen: number): Promise<"stop"> {
	const rec = await reconciledForCompletion(captured)
	if (!rec || genOf(rec.id) !== gen) return "stop"
	const settled = fuelSettledFor(rec)
	const patch: Partial<DepositJournalRecord> = settled ? { claimedByOther: true, completedAt: deps.now() } : { claimedByOther: true }
	const written = await underJournalLock(() =>
		genOf(rec.id) === gen
			? journalPatchWhen(
					deps.kv,
					rec.id,
					(live) =>
						sameClaimSnapshot(live, rec) && sameFuelState(live, rec) && !(live as ClaimRecord).claimTxHash && !live.completedAt,
					patch,
				)
			: undefined,
	)
	reload()
	if (!written) {
		log("claimed-by-another completion skipped - the record moved", rec.id)
		return "stop"
	}
	if (settled) finishDeposit(written as ClaimRecord)
	else setRuntime(rec.id, { attention: undefined, note: undefined, claimable: undefined })
	log("token claimed by another submitter", { id: rec.id, settled })
	return "stop"
}

/** A fuel leg with its own spending transaction (a private registration, a public fjwc claim) may
 *  be settled on chain with `consumed` not yet latched — the claim build would have caught up on
 *  its way to the hub. Reconcile it, then re-read; the live record must still be the captured one. */
async function reconciledForCompletion(captured: SendDepositRecord): Promise<SendDepositRecord | undefined> {
	if (!fuelSettledFor(captured) && captured.fuel?.claimTxHash && deps.reconcileFuel) {
		await deps.reconcileFuel(captured.id).catch((e) => log("fuel reconciliation failed", { id: captured.id, error: String(e) }))
		reload()
	}
	// Only the settlement flags may have moved: the reconciliation merges into the LIVE fuel block,
	// so a block another tab swapped in meanwhile would otherwise inherit the captured one's receipt.
	const live = engineRecords().find((r) => r.id === captured.id)
	if (!live || !sameClaimSnapshot(live, captured) || !sameFuelIdentity(live, captured)) return undefined
	return live as SendDepositRecord
}

/**
 * A persisted `claimedByOther` is a claim about the chain, and journal data alone never completes a
 * record: the fuel is reconciled first (no material needed), then the marker is re-read from the
 * nullifier. Automatic resumes use only the material at hand; an explicit click on a private record
 * unseals it (one signature). Nullified ⇒ the completion; still live ⇒ the marker was wrong and is
 * dropped, and the ordinary claim is back; no material or no evidence ⇒ the record waits.
 */
async function revalidateClaimedByOther(captured: SendDepositRecord, gen: number, interactive: boolean): Promise<"stop"> {
	const rec = await reconciledForCompletion(captured)
	if (!rec || genOf(rec.id) !== gen) return "stop"
	const material = claimMaterialOf(rec) ?? (await unsealForVerification(rec, interactive))
	if (!material) return "stop"
	const state = await probeClaimedElsewhere(rec, material)
	if (genOf(rec.id) !== gen) return "stop"
	if (state === "nullified") return completeClaimedByOther(rec, gen)
	if (state === "invalid") return reportTamperedMessage(rec.id)
	if (state === "live") {
		await underJournalLock(() =>
			journalPatchWhen(deps.kv, rec.id, (live) => sameClaimSnapshot(live, rec), { claimedByOther: undefined }),
		)
		reload()
		log("claimed-by-another marker dropped - the message is still live", rec.id)
	}
	return "stop"
}

/** The explicit click on a marked private record unseals it for the verification whatever its
 *  fuel says: a false marker would otherwise hide the ordinary claim that spends that fuel. */
async function unsealForVerification(rec: SendDepositRecord, interactive: boolean): Promise<ClaimMaterial | undefined> {
	if (!interactive || !rec.isPrivate || !rec.sealedEnvelope) return undefined
	return (await resolvePrivateClaimMaterial(rec, rec.id)) ?? undefined
}

/** The send tail: journal the hash the moment it exists, reset the round budget, record the
 *  forge-resistant provenance (THIS process watched claimable → sent), reread across the
 *  cross-tab window, then run the first receipt round. */
async function sendAndWatch(
	id: string,
	gen: number,
	interaction: { send: () => Promise<{ txHash: string; registerTxHash?: string }> },
): Promise<"continue" | "stop"> {
	setStep(id, "sending", "confirm in your Aztec wallet")
	const { txHash, registerTxHash } = await runOnLane("aztec", () => interaction.send())
	log("claim sent", { id, txHash, registerTxHash })
	// The registration is journalled together with the claim it precedes: the hub reports both
	// only once the claim is away, and a run that dies in between simply re-reads the hub and
	// claims plainly, so the two hashes never disagree about what landed.
	patchRecord(id, { claimTxHash: txHash, ...(registerTxHash ? { registerTxHash } : {}) })
	receiptRounds.delete(id)
	// The forge-resistant provenance - THIS process watched claimable → sent.
	localClaimProvenance.add(id)
	// Cross-tab guard: the record can vanish remotely between the send and this reread.
	const sent = engineRecords().find((r) => r.id === id) as ClaimRecord | undefined
	if (!sent) return "stop"
	return (await runReceiptRound(sent, gen)) === "continue" ? "continue" : "stop"
}

/** One ~3-minute receipt round (completion verification + narration). Returns "continue" when the claim
 *  is still pending and another round should be scheduled by the caller (outside the lock). */
async function runReceiptRound(rec: ClaimRecord, gen: number): Promise<"done" | "stop" | "continue"> {
	if (!receiptRoundReady(rec)) return "stop"
	const roundsDone = priorReceiptRounds(rec.id)
	const streaks = { dropped: 0, unreachable: 0 }
	for (let i = 0; i < RECEIPT_POLLS_PER_ROUND; i++) {
		if (genOf(rec.id) !== gen) return "stop" // A newer owner took over (RETRY/discard/sweep).
		const checkNo = roundsDone * RECEIPT_POLLS_PER_ROUND + i + 1
		setStep(rec.id, "confirming", "the claim is processing on Aztec")
		// Read-at-call-time under receiptRoundReady's gate (same parity pattern as the other deps).
		const status = await (deps.claimReceiptStatus as NonNullable<typeof deps.claimReceiptStatus>)(rec.claimTxHash as string)
		log("receipt check", { id: rec.id, checkNo, status })
		if (genOf(rec.id) !== gen) return "stop"
		flipProposedLanded(rec, status)
		// Success is the only arm that awaits; reverted and every non-terminal status stay
		// SYNCHRONOUS from the gen check through their runtime/streak writes (no new seams).
		if (status === "success") {
			const settled = await handleSuccessReceipt(rec, gen)
			if (settled === "poll") continue
			return settled
		}
		if (status === "reverted") return reportRevertedClaim(rec)
		if (advanceReceiptStreaks(rec.id, rec.claimTxHash as string, status, streaks) === "give-up") return "stop"
		await wait(4000)
	}
	return closeReceiptRound(rec.id, roundsDone)
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

/** Quiet flip: real evidence THIS claim was accepted into a proposed block. Display-only
 *  (the rail's dot goes mint); the round keeps polling to inclusion exactly as before. */
function flipProposedLanded(rec: ClaimRecord, status: string): void {
	if (status === "proposed" && runtime.value[rec.id]?.confirmLandedTxHash !== rec.claimTxHash) {
		setRuntime(rec.id, { confirmLandedTxHash: rec.claimTxHash })
	}
}

/** Both preconditions a round needs; callers guarantee them, this is the defensive form. */
function receiptRoundReady(rec: ClaimRecord): boolean {
	return !!deps.claimReceiptStatus && !!rec.claimTxHash
}

function priorReceiptRounds(id: string): number {
	return receiptRounds.get(id) ?? 0
}

/** A terminal revert clears the hash so RETRY re-enters the build path (a kept hash routed every
 *  retry back to the same reverted receipt). Expected-hash guard, not a CAS (localStorage has
 *  none): the clear applies only while the persisted hash is still the reverted one, so a late
 *  poll in this tab cannot wipe a fresh hash another tab already sent. Deliberately synchronous:
 *  it runs between a gen check and the loop's next step. */
function reportRevertedClaim(rec: ClaimRecord): "stop" {
	const expected = rec.claimTxHash
	const cleared = journalPatchWhen(deps.kv, rec.id, (live) => !!expected && (live as ClaimRecord).claimTxHash === expected, {
		claimTxHash: undefined,
	})
	if (cleared) {
		receiptRounds.delete(rec.id)
		reload()
		setRuntime(rec.id, {
			attention: "error",
			note: "The claim reverted on Aztec. You can retry from this card — the deposit remains claimable.",
			confirmLandedTxHash: undefined,
		})
	} else {
		// The hash this round polled is no longer the record's: a newer claim owns it now and
		// this runner has nothing to say about it — stop quietly, never "retry".
		log("reverted claim superseded by a newer hash - leaving the record to its owner", { id: rec.id })
		setRuntime(rec.id, { attention: undefined, note: undefined, confirmLandedTxHash: undefined })
	}
	return "stop"
}

/** The per-poll streak accounting (state threaded through one mutable object — the streaks
 *  reset at each round boundary by construction, since the object is round-local).
 *  Dropped is debounced: a freshly-proposed tx can read dropped/unknown transiently; three
 *  straight drops clear the hash — hash-scoping alone doesn't cover a SAME-hash resurrection
 *  (a restored backup can re-import the dropped hash), so the flag clears with it.
 *  Unreachable is independent: a dead RPC is a connectivity problem, never a slow claim. */
function advanceReceiptStreaks(
	id: string,
	polledHash: string,
	status: string,
	streaks: { dropped: number; unreachable: number },
): "give-up" | "poll" {
	if (status === "dropped") {
		streaks.dropped++
		if (streaks.dropped >= 3) {
			// Same expected-hash guard as the revert clear: only the hash this round polled is
			// cleared, never a fresh one another tab journaled while these three polls ran.
			const cleared = journalPatchWhen(deps.kv, id, (live) => (live as DepositJournalRecord).claimTxHash === polledHash, {
				claimTxHash: undefined,
			})
			if (cleared) {
				reload()
				setRuntime(id, {
					attention: "error",
					note: "The claim was dropped — claim again from this card. Nothing was lost.",
					confirmLandedTxHash: undefined,
				})
			} else {
				// The hash this round polled is no longer the record's: a newer claim owns it now
				// and this runner has nothing to say about it — stop quietly, never "claim again".
				log("dropped claim superseded by a newer hash - leaving the record to its owner", { id })
				setRuntime(id, { attention: undefined, note: undefined, confirmLandedTxHash: undefined })
			}
			return "give-up"
		}
	} else {
		streaks.dropped = 0
	}
	if (status === "unreachable") {
		streaks.unreachable++
		setStep(id, "confirming", `node unreachable — retrying (${streaks.unreachable})`)
	} else {
		streaks.unreachable = 0
	}
	return "poll"
}

/**
 * The success arm of a receipt poll. A checkpointed receipt for the recorded claimTxHash IS
 * confirmation (owner decision: the node's word beats the wallet's lagging PXE). The message
 * probe is best-effort: skipped when THIS process drove the send (forge-resistant provenance),
 * and for rediscovered records it can only DELAY completion while the PXE still visibly shows
 * the message as claimable - it can never dead-end a confirmed claim. Residual risk
 * (accepted): a forged-but-checkpointed claimTxHash planted in localStorage completes a
 * record; that attacker already has storage write and could delete the record outright.
 * "poll" = keep polling (the helper already waited its 4s).
 */
async function handleSuccessReceipt(rec: ClaimRecord, gen: number): Promise<"done" | "stop" | "poll"> {
	if (localClaimProvenance.has(rec.id)) {
		completeDeposit(engineRecords().find((r) => r.id === rec.id) as DepositJournalRecord | undefined)
		return "done"
	}
	setStep(rec.id, "verifying", "checking the claim against this record")
	const consumed = await recordMessageConsumed(rec)
	if (genOf(rec.id) !== gen) return "stop"
	if (consumed === "invalid") return reportTamperedMessage(rec.id)
	if (consumed === false) {
		// The PXE still sees the message - lag right after the checkpoint, or a receipt that
		// wasn't ours. Keep polling instead of completing; the next pass re-probes.
		setStep(rec.id, "verifying", "confirmed on the node — waiting for your wallet to sync")
		await wait(4000)
		return "poll"
	}
	completeDeposit(engineRecords().find((r) => r.id === rec.id) as DepositJournalRecord | undefined)
	return "done"
}

/** True/false when determinable; null when the secret isn't available for the probe (prompt-free
 *  rule); "invalid" when the record's message is provably not its own. A hub token send is read
 *  from its nullifier; every other shape keeps the claim-build probe. */
async function recordMessageConsumed(rec: ClaimRecord): Promise<boolean | null | "invalid"> {
	const material = claimMaterialOf(rec)
	if (!material) return null
	if (claimsThroughHub(rec) && deps.messageNullified) return nullifierSaysConsumed(rec, material)
	try {
		// The probe rebuilds the SAME claim the record would send, so a send record re-simulates
		// against the hub; an unwired dep throws here and reads as "unknown", never as consumed.
		const interaction = await buildClaimHandles(rec, { secretHex: material.secretHex })
		await interaction.simulate()
		return false // Still claimable ⇒ that successful receipt was NOT this record's claim.
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e)
		// CONSUMED (nullified), not merely NOT-READY: a not-yet-anchored message must return null
		// (unknown) here, never a false "consumed" — this record's claim may still be pending.
		if (isMsgConsumed(msg)) return true // The message is gone - consumed by the claim we waited on.
		return null
	}
}

function claimMaterialOf(rec: ClaimRecord): ClaimMaterial | undefined {
	if (rec.isPrivate) return secretCache.get(rec.id)
	const secretHex = publicClaimSecretOf(rec)
	return secretHex ? { secretHex } : undefined
}

async function nullifierSaysConsumed(rec: ClaimRecord, material: ClaimMaterial): Promise<boolean | null | "invalid"> {
	const state = await probeClaimedElsewhere(rec, material)
	if (state === "nullified") return true
	if (state === "live") return false
	if (state === "invalid") return "invalid"
	return null
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

/** A message someone else consumed is DONE, not failed: it named this record's L1 recipient, so the
 *  funds landed where the burn said they would. Recorded as its own fact — no consume transaction of
 *  ours exists to show — and terminal, because retrying can only ever fail the same way. */
function completeConsumedByOther(id: string): void {
	patchRecord(id, { consumedByOther: true } as Partial<BridgeJournalRecord>)
	completeWithdraw(engineRecords().find((r) => r.id === id) as ExitRecord | undefined)
	log("exit finished by another caller - marking complete", id)
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
	const consumed = await exitConsume(rec, (p) => noteProveProgress(id, p))
	if (consumed && "consumedByOther" in consumed) return completeConsumedByOther(id)
	const consumeTxHash = (consumed as { consumeTxHash: string }).consumeTxHash
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
	if (rec.completedAt) return "skip"
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
	return claimsThroughHub(rec) && rec.completedAt === undefined ? "deposit" : "skip"
}

/** Auto-continue ONLY what this page session initiated, plus prompt-free receipt waits. */
export function resumeSessionWork(): void {
	for (const rec of engineRecords()) {
		const action = resumeActionFor(rec)
		if (action === "deposit") void runDepositClaim(rec.id, { interactive: false })
		else if (action === "withdraw") void runWithdrawConsume(rec.id)
	}
}

/** Every record except the foregrounded one: while the wizard shows a record's stepper or receipt,
 *  that is its one surface, so no list renders it a second time. Records stay in storage. */
export const visibleRecords = computed(() => records.value.filter((r) => r.id !== activeFlowId.value))

export function useBridgeJournal() {
	initJournal()
	return {
		records,
		crossChainRecords,
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
