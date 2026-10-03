import type { EncryptionKey } from "@alejoamiras/nulo-wallet-crypto"
import type {
	BridgeJournalRecord,
	DepositFuelBlock,
	DepositJournalRecord,
	JournalTokenBlock,
	SendJournalRecord,
	WithdrawJournalRecord,
} from "./journal"
import { isProvisionalRecordId, isProvisionalWithdrawId } from "./journal"
import { openSecret, sealSecret } from "./recovery-crypto"

/**
 * Per-bridge recovery file: ONE journal record, ALWAYS sealed (public deposits hold their claim
 * secret plaintext in the record - it must never touch disk readable). The header carries
 * routing/UX copies of a few fields; it is NOT authenticated, so every header field is re-checked
 * against the unsealed record on open, and an unseal failure cannot be attributed - it reads as
 * "wrong wallet OR tampered/corrupted file". v1-only open (the envelope's no-fallback rule).
 */

export const BACKUP_FORMAT = "unleashed-bridge-backup"

export interface BridgeBackupFile {
	format: typeof BACKUP_FORMAT
	v: 1
	chainId: number
	portal: string
	bridge: string
	direction: "deposit" | "withdraw"
	id: string
	/** Captured at export (NOT a journal field for public/withdraw records) - display + routing only. */
	sealerL1: string
	blob: string
}

/** Parse + shape-check a candidate file. Throws specific, user-facing messages per ladder step. */
export function parseBackupFile(raw: unknown): BridgeBackupFile {
	let parsed: unknown = raw
	if (typeof raw === "string") {
		try {
			parsed = JSON.parse(raw)
		} catch {
			throw new Error("This is not an Unleashed bridge recovery file.")
		}
	}
	const f = parsed as Partial<BridgeBackupFile> | null
	if (!f || typeof f !== "object" || f.format !== BACKUP_FORMAT) {
		throw new Error("This is not an Unleashed bridge recovery file.")
	}
	if (f.v !== 1) {
		throw new Error("This recovery file was made by a newer version of the app — update and retry.")
	}
	if (
		typeof f.chainId !== "number" ||
		typeof f.portal !== "string" ||
		typeof f.bridge !== "string" ||
		(f.direction !== "deposit" && f.direction !== "withdraw") ||
		typeof f.id !== "string" ||
		f.id.length === 0 ||
		typeof f.sealerL1 !== "string" ||
		typeof f.blob !== "string" ||
		f.blob.length === 0
	) {
		throw new Error("This recovery file is malformed.")
	}
	if (isProvisionalWithdrawId(f.id)) {
		throw new Error("This file holds a half-started withdraw with nothing restorable in it.")
	}
	return f as BridgeBackupFile
}

const isDecimalString = (v: unknown): v is string => typeof v === "string" && /^\d+$/.test(v)
const isOptionalString = (v: unknown): v is string | undefined => v === undefined || typeof v === "string"
const isOptionalNumber = (v: unknown): v is number | undefined => v === undefined || typeof v === "number"
const isOptionalBoolean = (v: unknown): v is boolean | undefined => v === undefined || typeof v === "boolean"
const isOptionalDecimalString = (v: unknown): v is string | undefined => v === undefined || isDecimalString(v)

const INVALID = "The sealed contents are not a valid bridge record."

/** The facts every record carries whatever its direction. */
function assertBaseFacts(r: Partial<BridgeJournalRecord> | null): void {
	if (
		!r ||
		typeof r !== "object" ||
		(r.schema !== 1 && r.schema !== 2) ||
		typeof r.id !== "string" ||
		r.id.length === 0 ||
		typeof r.isPrivate !== "boolean" ||
		!isDecimalString(r.amount) ||
		typeof r.createdAt !== "number" ||
		typeof r.updatedAt !== "number" ||
		!isOptionalNumber(r.completedAt) ||
		typeof r.chainId !== "number" ||
		typeof r.portal !== "string" ||
		typeof r.bridge !== "string" ||
		!isOptionalString(r.blocked)
	) {
		throw new Error(INVALID)
	}
}

/** Deposit identity, recovery material, and every milestone a writer persists. EVERY optional
 *  field is type-checked when present: each one is written by some flow, so a wrong-typed copy is
 *  a rewritten record rather than an older one, and guessing past it is how a forged field reaches
 *  a claim. */
function assertDepositFacts(d: Partial<DepositJournalRecord>): void {
	if (
		typeof d.recipient !== "string" ||
		typeof d.secretHashHex !== "string" ||
		!isOptionalString(d.secret) ||
		!isOptionalString(d.sealedEnvelope) ||
		!isOptionalString(d.sealerL1) ||
		!isOptionalString(d.sender) ||
		!isOptionalString(d.approveTxHash) ||
		!isOptionalString(d.depositTxHash) ||
		!isOptionalString(d.leafIndex) ||
		!isOptionalString(d.messageHash) ||
		!isOptionalString(d.claimTxHash) ||
		!isOptionalBoolean(d.claimedByOther) ||
		!isOptionalNumber(d.depositL2Block) ||
		(d.assetKind !== undefined && d.assetKind !== "bridge-token" && d.assetKind !== "fee-juice")
	) {
		throw new Error(INVALID)
	}
}

/** Schema 2 ⟺ fuel present, validated strictly; schema 1 must NOT carry fuel. Malformed fuel
 *  metadata rejects the restore outright - never guessed through. The private-fuel extras
 *  (salt/fpc/insufficiency) are recovery inputs for a private Fuel claim and get the same bar. */
function assertFuelBlock(d: Partial<DepositJournalRecord>): void {
	if (d.schema !== 2) {
		if (d.fuel !== undefined) throw new Error(INVALID)
		return
	}
	const f = d.fuel as Partial<DepositFuelBlock> | undefined
	if (
		!f ||
		typeof f !== "object" ||
		!isDecimalString(f.amount) ||
		typeof f.secret !== "string" ||
		f.secret.length === 0 ||
		typeof f.secretHashHex !== "string" ||
		!isDecimalString(f.minOutput) ||
		!isOptionalDecimalString(f.leafIndex) ||
		!isOptionalString(f.messageHash) ||
		!isOptionalDecimalString(f.received) ||
		!isOptionalNumber(f.claimAttemptAt) ||
		!isOptionalBoolean(f.claimAttempt) ||
		!isOptionalString(f.claimTxHash) ||
		!isOptionalBoolean(f.consumed) ||
		!isOptionalBoolean(f.standaloneClaimed) ||
		!isOptionalString(f.bridgeSecretSalt) ||
		!isOptionalString(f.fpc) ||
		!isOptionalBoolean(f.setupInsufficiency)
	) {
		throw new Error(INVALID)
	}
}

function assertWithdrawFacts(w: Partial<WithdrawJournalRecord>): void {
	if (
		w.schema !== 1 ||
		typeof w.recipientL1 !== "string" ||
		!isOptionalString(w.exitTxHash) ||
		!isOptionalNumber(w.exitBlock) ||
		!isOptionalString(w.consumeTxHash) ||
		!isOptionalBoolean(w.consumedByOther) ||
		!isOptionalString(w.sender) ||
		isProvisionalWithdrawId(w.id as string)
	) {
		throw new Error(INVALID)
	}
}

/** STRICT per-direction guard for foreign input - the journal's shallow parse filter is for OUR
 *  own storage, never for a file someone handed us. */
export function validateBackupRecord(rec: unknown): BridgeJournalRecord {
	const r = rec as Partial<BridgeJournalRecord> | null
	assertBaseFacts(r)
	if (r?.direction === "deposit") {
		const d = r as Partial<DepositJournalRecord>
		assertDepositFacts(d)
		assertFuelBlock(d)
		return d as DepositJournalRecord
	}
	if (r?.direction === "withdraw") {
		const w = r as Partial<WithdrawJournalRecord>
		assertWithdrawFacts(w)
		return w as WithdrawJournalRecord
	}
	throw new Error(INVALID)
}

const isHexWord = (v: unknown): v is string => typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v)
const isEvmAddress = (v: unknown): v is string => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v)

/** The token block of a schema-3 record: every field a claim or exit is rebuilt from, strictly typed. */
function validateTokenBlock(t: unknown): JournalTokenBlock {
	const b = t as Partial<JournalTokenBlock> | null
	if (
		!b ||
		typeof b !== "object" ||
		!isEvmAddress(b.erc20) ||
		!isEvmAddress(b.portal) ||
		!isHexWord(b.l2Token) ||
		!isHexWord(b.nameWord) ||
		!isHexWord(b.symbolWord) ||
		typeof b.decimals !== "number" ||
		!Number.isInteger(b.decimals) ||
		b.decimals < 0 ||
		b.decimals > 255 ||
		typeof b.displaySymbol !== "string" ||
		!isOptionalString(b.registerKey) ||
		!isOptionalDecimalString(b.registerIndex)
	) {
		throw new Error(INVALID)
	}
	return b as JournalTokenBlock
}

interface SendShape {
	schema?: unknown
	direction?: unknown
	intent?: unknown
	token?: unknown
	fuel?: unknown
	registerTxHash?: unknown
	registers?: unknown
}

/** Runs the schema-1/2 validator over the shared facts of a schema-3 record. */
function validateSendSharedFacts(r: SendShape): BridgeJournalRecord {
	const sharedSchema = r.direction === "withdraw" || r.fuel === undefined ? 1 : 2
	return validateBackupRecord({
		...r,
		schema: sharedSchema,
		intent: undefined,
		token: undefined,
		registerTxHash: undefined,
		registers: undefined,
	})
}

/** `registers` is a flag or absent, and only a deposit with a token leg can carry it. */
function validateRegisters(r: SendShape): void {
	if (r.registers === undefined) return
	if (r.registers !== true || r.direction !== "deposit" || r.intent === "gas") throw new Error(INVALID)
}

function validateSendIntent(r: SendShape): "token" | "token+gas" | "gas" {
	if (r.intent === "gas") {
		if (r.direction !== "deposit" || r.token !== undefined) throw new Error(INVALID)
		return "gas"
	}
	if (r.intent !== "token" && r.intent !== "token+gas") throw new Error(INVALID)
	if (r.direction === "withdraw" && r.intent !== "token") throw new Error(INVALID)
	return r.intent
}

/**
 * Schema-3 records reuse the schema-2 deposit / schema-1 withdraw validation for their shared facts
 * and add the intent + token block. A token-moving record without its block, or a gas-only record
 * carrying one, is rejected — the block is what binds the record to ONE token's clone and L2 token,
 * so a restore can never be claimed against another.
 */
function validateSendRecord(rec: unknown): SendJournalRecord {
	const r = rec as SendShape | null
	if (!r || typeof r !== "object" || r.schema !== 3) throw new Error(INVALID)
	if (r.direction === "deposit" && !isOptionalString(r.registerTxHash)) throw new Error(INVALID)
	validateRegisters(r)
	const shared = validateSendSharedFacts(r)
	const intent = validateSendIntent(r)
	const registerTxHash = r.direction === "deposit" ? (r.registerTxHash as string | undefined) : undefined
	if (intent === "gas") return { ...(shared as object), schema: 3, intent, registerTxHash } as SendJournalRecord
	const token = validateTokenBlock(r.token)
	if (token.portal.toLowerCase() !== shared.portal.toLowerCase()) throw new Error(INVALID)
	const registers = r.registers === true ? { registers: true as const } : {}
	return { ...(shared as object), schema: 3, intent, token, registerTxHash, ...registers } as SendJournalRecord
}

/** Any record shape the journal can hold; schema 3 dispatches to its own validator. */
export function validateAnyBackupRecord(rec: unknown): BridgeJournalRecord {
	const schema = (rec as { schema?: unknown } | null)?.schema
	return schema === 3 ? validateSendRecord(rec) : validateBackupRecord(rec)
}

interface BackupPayload {
	bk: 1
	record: BridgeJournalRecord
}

/** Seal ONE record into a recovery file. Refuses records with nothing restorable in them:
 *  provisional records on either lane, and private deposits whose envelope hasn't been sealed yet -
 *  a file without the recovery material would toast success today and strand the claim later. */
export async function sealBridgeBackup(key: EncryptionKey, record: BridgeJournalRecord, sealerL1: string): Promise<BridgeBackupFile> {
	if (isProvisionalRecordId(record.id)) {
		throw new Error("This transfer has not reached its own transaction yet — there is nothing restorable to save.")
	}
	if (record.direction === "deposit" && record.isPrivate && !record.sealedEnvelope) {
		throw new Error("This private deposit hasn't sealed its recovery secret yet — try again in a moment.")
	}
	const payload: BackupPayload = { bk: 1, record }
	return {
		format: BACKUP_FORMAT,
		v: 1,
		chainId: record.chainId,
		portal: record.portal,
		bridge: record.bridge,
		direction: record.direction,
		id: record.id,
		sealerL1,
		blob: await sealSecret(key, JSON.stringify(payload)),
	}
}

/** Unseal + deep-validate + header-cross-check. GCM failure throws the attribution-honest copy. */
export async function openBridgeBackup(key: EncryptionKey, file: BridgeBackupFile): Promise<BridgeJournalRecord> {
	let plaintext: string
	try {
		plaintext = await openSecret(key, file.blob)
	} catch {
		throw new Error("Couldn't open this file: it wasn't sealed by the connected Ethereum account, or the file is corrupted/tampered.")
	}
	let parsed: unknown
	try {
		parsed = JSON.parse(plaintext)
	} catch {
		throw new Error("The sealed contents are not a valid bridge record.")
	}
	const payload = parsed as Partial<BackupPayload>
	if (payload?.bk !== 1 || !payload.record) {
		throw new Error("The sealed contents are not a valid bridge record.")
	}
	const record = validateAnyBackupRecord(payload.record)
	// The header is unauthenticated routing data - the SEALED copies are authoritative. Every
	// header field with a sealed counterpart is re-checked (sealerL1 only exists inside private
	// deposit records); refuse on any edit rather than trust either side.
	if (
		record.id !== file.id ||
		record.direction !== file.direction ||
		record.chainId !== file.chainId ||
		record.portal !== file.portal ||
		record.bridge !== file.bridge ||
		(record.direction === "deposit" && record.sealerL1 !== undefined && record.sealerL1 !== file.sealerL1)
	) {
		throw new Error("This file's label doesn't match its sealed contents — it was modified. Refusing to restore.")
	}
	return record
}
