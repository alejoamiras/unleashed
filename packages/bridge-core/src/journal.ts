/**
 * The in-flight bridge journal: every deposit/withdraw the user has started and not yet
 * cleared, multi-entry, device-local. Replaces the single-pending-per-direction records.
 *
 * Trust model (the part that must not regress):
 *  - Records persist MILESTONE FACTS only (tx hashes, leafIndex, completedAt) - display stages
 *    are DERIVED at runtime, so storage cannot lie about progress, only about facts whose
 *    tampering is individually bounded.
 *  - For PRIVATE deposits the plaintext `recipient`/`amount` are display-only; the authoritative
 *    copies live inside the AES-GCM sealed envelope (recovery-crypto). Public deposits and all
 *    withdraws are self-authenticating on-chain (their messages bind recipient+amount).
 *  - Writes are per-record read-merge-write: every mutation re-reads the journal and replaces
 *    only its own record, so a stale snapshot in another tab cannot erase an unrelated record
 *    (which for a private deposit would destroy the only sealed recovery blob).
 *
 * Storage is injected (`KV`) so this stays pure + unit-testable; the frontend passes
 * `window.localStorage`.
 */

import { validateAnyBackupRecord } from "./backup"

export interface KV {
	getItem(key: string): string | null
	setItem(key: string, value: string): void
	removeItem(key: string): void
}

/** Every storage key the journal owns starts with this; a `storage` event is matched against it. */
export const JOURNAL_KEY_PREFIX = "unleashed-bridge:journal"

export const JOURNAL_KEY = `${JOURNAL_KEY_PREFIX}:v1`

/** Where entries that failed the load-time validation are parked. Never read as records. */
export const QUARANTINE_KEY = `${JOURNAL_KEY_PREFIX}:quarantine`

/** Parse cap - storage-flooding guard. Eviction is prioritized: unfinished records survive
 *  first, then newest completed; junk can never evict a live record. */
export const MAX_RECORDS = 100

interface JournalBase {
	/** Record-shape version, distinct from the storage ENVELOPE version (which `write()` keeps at 1).
	 *  1 = original; 2 = carries the optional `fuel` block. For deposits it is redundant with `!!fuel`
	 *  (kept explicit for back-compat); withdraws are always 1. Private-fuel fields are additive WITHIN
	 *  schema 2 — no bump: an old client reads a private record as a public schema-2 record minus the
	 *  optional private fields. */
	schema: 1 | 2 | 3
	/** Deposits: secretHashHex, or a provisional `dep-pending-<rand>` until the send derives it.
	 *  Withdraws: exitTxHash, or a provisional `wd-pending-<rand>` between send and receipt. */
	id: string
	direction: "deposit" | "withdraw"
	isPrivate: boolean
	/** Base units, decimal string. DISPLAY-ONLY for private deposits (authoritative copy sealed). */
	amount: string
	createdAt: number
	updatedAt: number
	/** Terminal: set only after the record's SPECIFIC tx passed the identity checks. */
	completedAt?: number
	/** Deployment binding - a record from a different deployment refuses resume (stale-deployment). */
	chainId: number
	portal: string
	bridge: string
	/** Set when a re-read of the chain contradicted the record's own token facts. Terminal: a
	 *  blocked record never runs again, so a rewritten block can never be claimed or exited
	 *  against; only discarding it clears the state. */
	blocked?: string
}

/** The fuel side of a fueled deposit. All amounts base-unit decimal strings. */
export interface DepositFuelBlock {
	/** The AZLO slice swapped on L1 (display + total reconstruction; record.amount stays the TOKEN claim amount). */
	amount: string
	/** FJ claim secret - recipient-bound (gates WHO TRIGGERS the claim, never where funds land). Plaintext like public deposit secrets. */
	secret: string
	secretHashHex: string
	/** The SIGNED slippage floor that was in the witness. */
	minOutput: string
	/** From the BridgeWithFuel event. */
	leafIndex?: string
	/** The L1→L2 message key (inbox leaf hash) from `BridgeWithFuel.fuelKey`. The 5.0 readiness gate polls
	 *  `getL1ToL2MessageCheckpoint(messageHash)` on this — recomputing the leaf locally is fragile, and the
	 *  real key is exactly what the inbox inserted. */
	messageHash?: string
	/** fuelReceived from the event - the EXACT content-hash amount; the claim MUST use this, never a quote. */
	received?: string
	/** Epoch-ms of the LAST claim attempt latch. Missing on pre-fix records ⇒ treated as aged out,
	 *  so a receipt stuck in "pending" limbo (vanished tx, node that never reports "dropped") can
	 *  re-enter the retry path instead of waiting forever. */
	claimAttemptAt?: number
	/** Latched journal-first BEFORE any fjwc-embedded wallet call. */
	claimAttempt?: boolean
	/** The fjwc attempt's tx hash, persisted as soon as the wallet returns it. */
	claimTxHash?: string
	/** Set when an fjwc-embedded claim tx reads INCLUDED (success OR app-revert) - the FJ message is consumed. */
	consumed?: boolean
	/** Set when a standalone sponsored FJ claim landed (the fee-spike path or the card's recovery
	 *  action). Distinguishes "fuel recovered separately" from "still stranded".
	 *  PUBLIC fuel only — the private path NEVER uses a sponsored/public standalone claim (privacy). */
	standaloneClaimed?: boolean
	/** PRIVATE fuel only — the per-deposit salt fed to `deriveBridgeSecret(salt, claimer)`; the claim
	 *  rebuilds the FJ secret from it. Random per deposit (the PrivateFPC nullifier binds it, so reuse
	 *  collides). DISTINCT from the FPC-ADDRESS salt (always `Fr.zero()`). For private records the
	 *  authoritative copy is sealed (recovery-crypto); this plaintext copy is a display/recovery hint. */
	bridgeSecretSalt?: string
	/** PRIVATE fuel only — the PrivateFPC L2 address the FJ was deposited to (`fuelRecipient`).
	 *  Persisted for post-hoc address-drift detection and to rebuild the claim. */
	fpc?: string
	/** PRIVATE fuel only — set when the last send was refused before any transaction existed: the
	 *  `mint_and_pay_fee` insufficiency assert, or a Fee Juice message the wallet could not consume yet
	 *  (both INVALID pre-inclusion, so the FJ stays unconsumed). The ONE signal that authorises a retry
	 *  of the private claim without a tx hash (the narrow allow-list); cleared once a hash lands. */
	setupInsufficiency?: boolean
}

export interface DepositJournalRecord extends JournalBase {
	schema: 1 | 2
	direction: "deposit"
	/** Which asset this deposit bridges. Absent ⇒ "bridge-token" (ADDITIVE — pre-Fuel records have no
	 *  field and the loader never gates on it). "fee-juice" = a direct Fuel bridge (L1 fee asset → L2 Fee
	 *  Juice via the canonical FeeJuicePortal); its deployment binding is {portal: FeeJuicePortal, bridge:
	 *  L2 FeeJuice address}, NOT the token bridge. */
	assetKind?: "bridge-token" | "fee-juice"
	/** Display + pre-unseal guard for private; claim arg for public (self-authenticating on-chain). */
	recipient: string
	/** PUBLIC only - recipient-bound by the L1 content hash (tamper ⇒ claim fails, never redirects). */
	secret?: string
	/** PRIVATE only - the AES-GCM envelope holding {secret, recipient, amount, sealerL1, leafIndex?}. */
	sealedEnvelope?: string
	secretHashHex: string
	/** Display copy of the sealing L1 account (authoritative copy lives inside the envelope). */
	sealerL1?: string
	/** The L1 account that signed the deposit, recorded when the record is built. Display-only; never
	 *  read by a claim, exit or recovery path. Absent on records written before the field existed. */
	sender?: string
	/** The one-time Permit2 approval's tx hash, when THIS deposit performed it — persisted so a
	 *  post-approval rejection/timeout still shows the mined approval (a standing max allowance)
	 *  instead of "nothing was sent". */
	approveTxHash?: string
	/** Persisted the moment writeContract returns - leafIndex stays chain-recoverable. */
	depositTxHash?: string
	leafIndex?: string
	/** The token L1→L2 message key (inbox leaf hash) from `BridgeWithFuel.tokenKey` / the DepositToAztec
	 *  event. The 5.0 readiness gate polls `getL1ToL2MessageCheckpoint` on this before simulating the claim. */
	messageHash?: string
	claimTxHash?: string
	/** The token message was consumed by another submitter (a relayer, another tab): proven by the
	 *  message's own nullifier, so the tokens arrived without a claim of ours. Recorded as its own fact
	 *  — there is no `claimTxHash` to show. */
	claimedByOther?: boolean
	/** The Aztec block height when the L1 deposit confirmed - anchors the sync countdown
	 *  (display pacing only; the claim-simulate gate stays the consumability authority). */
	depositL2Block?: number
	/** Present ⟺ schema 2: the deposit bought fuel on the way in. */
	fuel?: DepositFuelBlock
}

export interface WithdrawJournalRecord extends JournalBase {
	schema: 1 | 2
	direction: "withdraw"
	/** Bound in the L2→L1 message - tamper makes the consume revert. */
	recipientL1: string
	exitTxHash?: string
	exitBlock?: number
	consumeTxHash?: string
	/** The Outbox says this exit's message is already consumed while THIS app never sent a finish
	 *  transaction: the message names its L1 recipient, so a relayer that got there first released
	 *  the funds to the same address. Terminal — there is nothing left to consume, and retrying
	 *  forever is the only other outcome. */
	consumedByOther?: boolean
	/** The Aztec account that sent the exit, recorded when the record is built. Display-only; never
	 *  read by a claim, exit or recovery path. Absent on records written before the field existed. */
	sender?: string
}

/**
 * The token a schema-3 record moves, copied from the factory's frozen registration record once the
 * L1 receipt exists (the pre-receipt copy is the app's prediction; the receipt rewrite is what the
 * L2 side is claimed against). `portal` here and `JournalBase.portal` are the same clone.
 */
export interface JournalTokenBlock {
	erc20: string
	portal: string
	l2Token: string
	nameWord: string
	symbolWord: string
	decimals: number
	displaySymbol: string
	/** From the factory's `PortalCreated`/`registrationOf` — the `register` leaf a first claim consumes. */
	registerKey?: string
	registerIndex?: string
}

/** What a send intends: the token leg, the token leg plus a gas slice, or gas only (no token block). */
export type SendIntent = { intent: "token" | "token+gas"; token: JournalTokenBlock } | { intent: "gas"; token?: never }

/**
 * Schema 3: one record per send through the hub. `bridge` is the hub, `portal` the token's clone
 * (or the FeeJuicePortal for a gas-only send). Deposit facts are the schema-2 ones; a first-time
 * private deposit additionally records its own L2 `register_token` tx.
 */
export type SendDepositRecord = Omit<DepositJournalRecord, "schema" | "assetKind"> & {
	schema: 3
	/** Set when the hub had not registered the token at send time: this send's claim registers it
	 *  (in its own tx for a private deposit, inside the claim for a public one). */
	registers?: true
	/** The L2 registration tx of a first-time private deposit (the claim is the next tx). */
	registerTxHash?: string
} & SendIntent

export type SendWithdrawRecord = Omit<WithdrawJournalRecord, "schema"> & {
	schema: 3
	intent: "token"
	token: JournalTokenBlock
}

export type SendJournalRecord = SendDepositRecord | SendWithdrawRecord

export type BridgeJournalRecord = DepositJournalRecord | WithdrawJournalRecord | SendJournalRecord

export function isSendRecord(rec: BridgeJournalRecord): rec is SendJournalRecord {
	return rec.schema === 3
}

/** Schema-3 display stages: a first-time private deposit passes through `registering` before the claim. */
export type SendDepositStage = DepositStage | "registering"

/** The facts a stage is derived from — every deposit shape carries them, so one rail serves them all. */
export type DepositStageFacts = Pick<SendDepositRecord, "completedAt" | "claimTxHash" | "registerTxHash" | "leafIndex">

export function deriveSendDepositStage(rec: DepositStageFacts, runtime: DepositStageRuntime = {}): SendDepositStage {
	if (rec.completedAt) return "done"
	if (rec.claimTxHash) return "claiming"
	if (rec.registerTxHash) return "registering"
	if (rec.leafIndex) return runtime.claimable ? "claimable" : "syncing"
	return "depositing"
}

/** The deposit's asset variant. A send record takes it from `intent`; on any other record the field
 *  is optional and absent means a token bridge. Withdraws are always token-bridge. The ONE
 *  place the default is decided, so every consumer (deploymentMatches, backup, receipt) agrees. */
export function assetKindOf(rec: BridgeJournalRecord): "bridge-token" | "fee-juice" {
	if (isSendRecord(rec)) return rec.direction === "deposit" && rec.intent === "gas" ? "fee-juice" : "bridge-token"
	return rec.direction === "deposit" && rec.assetKind === "fee-juice" ? "fee-juice" : "bridge-token"
}

/** Canonical display stages - closed sets, stable for e2e selectors. */
export type DepositStage = "depositing" | "syncing" | "claimable" | "claiming" | "done"
export type WithdrawStage = "exiting" | "proving" | "consumable" | "consuming" | "done"

const WITHDRAW_PENDING = "wd-pending-"
const DEPOSIT_PENDING = "dep-pending-"
const pendingSuffix = () => Math.random().toString(36).slice(2, 10)

export function makeProvisionalWithdrawId(): string {
	return `${WITHDRAW_PENDING}${pendingSuffix()}`
}

/** The id a deposit is journaled under before its own claim hash exists — everything the L1 leg
 *  narrates (the Permit2 approval above all) needs a record to narrate into. */
export function makeProvisionalDepositId(): string {
	return `${DEPOSIT_PENDING}${pendingSuffix()}`
}

export function isProvisionalWithdrawId(id: string): boolean {
	return id.startsWith(WITHDRAW_PENDING)
}

/** Any id a flow minted before its own transaction named the record: there is nothing in such a
 *  record a backup or a resume could act on. */
export function isProvisionalRecordId(id: string): boolean {
	return id.startsWith(WITHDRAW_PENDING) || id.startsWith(DEPOSIT_PENDING)
}

/** The id stood in while a half-started row is validated: the file validator refuses a provisional
 *  withdraw id outright (a recovery file must never carry one), while our own storage legitimately
 *  holds such rows between a send and the receipt that names them. */
const PROBE_ID = `0x${"0".repeat(64)}`

/**
 * Deep-validate ONE stored entry with the strictness an imported recovery file gets. Storage is not
 * a trusted channel: a token block from here reaches the wallet's grant + contract registration, so
 * its words must be as strictly shaped as a file's, and a half-shaped schema-3 row would otherwise
 * crash the boot that reads it. Null = the entry does not run and does not render.
 */
function validateStoredRecord(entry: unknown): BridgeJournalRecord | null {
	const id = (entry as { id?: unknown } | null)?.id
	if (typeof id !== "string" || id.length === 0) return null
	try {
		const rec = validateAnyBackupRecord(isProvisionalRecordId(id) ? { ...(entry as object), id: PROBE_ID } : entry)
		return { ...rec, id } as BridgeJournalRecord
	} catch {
		return null
	}
}

/** The stored entries split into what may run and what may not. */
interface JournalPartition {
	records: BridgeJournalRecord[]
	invalid: unknown[]
}

function partitionStored(raw: string | null): JournalPartition {
	if (!raw) return { records: [], invalid: [] }
	let parsed: { schema?: number; records?: unknown }
	try {
		parsed = JSON.parse(raw) as { schema?: number; records?: unknown }
	} catch {
		return { records: [], invalid: [] }
	}
	if (parsed?.schema !== 1 || !Array.isArray(parsed.records)) return { records: [], invalid: [] }
	const records: BridgeJournalRecord[] = []
	const invalid: unknown[] = []
	for (const entry of parsed.records) {
		const rec = validateStoredRecord(entry)
		if (rec) records.push(rec)
		else invalid.push(entry)
	}
	return { records: capRecords(records), invalid }
}

/** The quarantined entries exactly as stored — they failed validation, so they are never records. */
export function loadQuarantine(kv: KV): unknown[] {
	try {
		const parsed = JSON.parse(kv.getItem(QUARANTINE_KEY) ?? "null") as { schema?: number; records?: unknown }
		return parsed?.schema === 1 && Array.isArray(parsed.records) ? parsed.records : []
	} catch {
		return []
	}
}

/**
 * Park every entry that failed validation under the quarantine key and rewrite the journal without
 * them. Run once at startup, BEFORE anything writes: every write round-trips through `loadJournal`,
 * so a sweep that never ran would let the first patch drop an unreadable row for good. Returns how
 * many entries moved; no write at all when everything validated.
 */
export function quarantineInvalid(kv: KV): number {
	const { records, invalid } = partitionStored(kv.getItem(JOURNAL_KEY))
	if (invalid.length === 0) return 0
	const held = loadQuarantine(kv)
	kv.setItem(QUARANTINE_KEY, JSON.stringify({ schema: 1, records: [...held, ...invalid].slice(-MAX_RECORDS) }))
	write(kv, records)
	return invalid.length
}

/** Prioritized retention under MAX_RECORDS: unfinished records are NEVER evicted - an unfinished
 *  private deposit may hold the only sealed recovery blob, and an attacker who can flood storage
 *  with unfinished junk could otherwise use the cap itself as an eviction tool (worse than the
 *  deletion he can already do directly). The cap trims only completed records, newest first; a
 *  junk flood degrades the UI, never the data. */
export function capRecords(records: BridgeJournalRecord[]): BridgeJournalRecord[] {
	if (records.length <= MAX_RECORDS) return records
	const unfinished = records.filter((r) => !r.completedAt)
	const completed = records.filter((r) => r.completedAt).sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0))
	return [...unfinished, ...completed.slice(0, Math.max(0, MAX_RECORDS - unfinished.length))]
}

export function loadJournal(kv: KV): BridgeJournalRecord[] {
	return partitionStored(kv.getItem(JOURNAL_KEY)).records
}

function write(kv: KV, records: BridgeJournalRecord[]): void {
	kv.setItem(JOURNAL_KEY, JSON.stringify({ schema: 1, records: capRecords(records) }))
}

/** Insert-or-replace by id - re-reads the journal first (per-record merge; see module header). */
export function upsertRecord(kv: KV, rec: BridgeJournalRecord): void {
	const records = loadJournal(kv)
	const next = { ...rec, updatedAt: Date.now() }
	const i = records.findIndex((r) => r.id === rec.id)
	if (i >= 0) records[i] = next
	else records.push(next)
	write(kv, records)
}

/** Shallow-merge a patch into one record (re-read first). No-op if the id is gone. */
export function patchRecord(kv: KV, id: string, patch: Partial<BridgeJournalRecord>): BridgeJournalRecord | undefined {
	return patchRecordWhen(kv, id, () => true, patch)
}

/** `patchRecord` guarded by a predicate over the freshly loaded record: a no-op (undefined) when
 *  the id is gone or the guard rejects. Load, guard and write are one synchronous span — the
 *  closest thing to a compare-and-set that localStorage offers, not an atomic one. A patch given
 *  as a function is computed from that same loaded record, so a nested block can be merged onto
 *  the copy the guard just accepted rather than one captured earlier. */
export function patchRecordWhen(
	kv: KV,
	id: string,
	when: (current: BridgeJournalRecord) => boolean,
	patch: Partial<BridgeJournalRecord> | ((current: BridgeJournalRecord) => Partial<BridgeJournalRecord>),
): BridgeJournalRecord | undefined {
	const records = loadJournal(kv)
	const i = records.findIndex((r) => r.id === id)
	if (i < 0 || !when(records[i])) return undefined
	const fields = typeof patch === "function" ? patch(records[i]) : patch
	const next = { ...records[i], ...fields, id: records[i].id, updatedAt: Date.now() } as BridgeJournalRecord
	records[i] = next
	write(kv, records)
	return next
}

/** Replace a record under a NEW id (the provisional-withdraw → exitTxHash upgrade). */
export function rekeyRecord(kv: KV, oldId: string, next: BridgeJournalRecord): void {
	const records = loadJournal(kv).filter((r) => r.id !== oldId && r.id !== next.id)
	records.push({ ...next, updatedAt: Date.now() })
	write(kv, records)
}

/** `rekeyRecord` guarded the way `patchRecordWhen` is: the source must still exist and pass `when`
 *  (which also sees the whole journal), and no record may already hold the new id — unlike the
 *  unguarded form, this never overwrites a destination. One synchronous load → guard → write. */
export function rekeyRecordWhen(
	kv: KV,
	oldId: string,
	when: (current: BridgeJournalRecord, all: BridgeJournalRecord[]) => boolean,
	next: BridgeJournalRecord,
): boolean {
	const records = loadJournal(kv)
	const current = records.find((r) => r.id === oldId)
	if (!current || records.some((r) => r.id === next.id) || !when(current, records)) return false
	write(kv, [...records.filter((r) => r.id !== oldId), { ...next, updatedAt: Date.now() }])
	return true
}

export function removeRecord(kv: KV, id: string): void {
	const records = loadJournal(kv)
	const next = records.filter((r) => r.id !== id)
	if (next.length !== records.length) write(kv, next)
}

/** Drop completed records older than `olderThanMs` (the 7-day prune; only verified
 *  completions ever carry `completedAt`, so this never destroys an unverified blob). */
export function pruneCompleted(kv: KV, olderThanMs: number, now = Date.now()): void {
	const records = loadJournal(kv)
	const next = records.filter((r) => !r.completedAt || now - r.completedAt < olderThanMs)
	if (next.length !== records.length) write(kv, next)
}

/** Runtime inputs the persisted facts can't know (live chain/PXE state picks within a pair). */
export interface DepositStageRuntime {
	/** True once the record's claim simulates cleanly (public) or is presumed ready (private). */
	claimable?: boolean
}
export interface WithdrawStageRuntime {
	/** True once the exit's block is covered by the proven chain tip. */
	proven?: boolean
}

export function deriveDepositStage(rec: DepositJournalRecord, runtime: DepositStageRuntime = {}): DepositStage {
	if (rec.completedAt) return "done"
	if (rec.claimTxHash) return "claiming"
	if (rec.leafIndex) return runtime.claimable ? "claimable" : "syncing"
	return "depositing"
}

export function deriveWithdrawStage(rec: WithdrawJournalRecord, runtime: WithdrawStageRuntime = {}): WithdrawStage {
	if (rec.completedAt) return "done"
	if (rec.consumeTxHash) return "consuming"
	if (rec.exitTxHash) return runtime.proven ? "consumable" : "proving"
	return "exiting"
}
