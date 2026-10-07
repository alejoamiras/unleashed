import { describe, expect, it } from "vitest"
import { EncryptionKey } from "@nulo-sh/wallet-crypto"
import {
	type BridgeBackupFile,
	openBridgeBackup,
	parseBackupFile,
	sealBridgeBackup,
	validateAnyBackupRecord,
	validateBackupRecord,
} from "./backup"
import type { DepositJournalRecord, JournalTokenBlock, SendDepositRecord, SendWithdrawRecord, WithdrawJournalRecord } from "./journal"

const SEALER = "0xef4d9e1f4e9e2dd9e747b53f4be3d04bfa935f2d"
const DEPLOY = { chainId: 11155111, portal: "0xportal", bridge: "0xbridge" }

const key = await EncryptionKey.fromPassword("0xsig-deterministic")
const otherKey = await EncryptionKey.fromPassword("0xsig-other-wallet")

function publicDeposit(over: Partial<DepositJournalRecord> = {}): DepositJournalRecord {
	return {
		schema: 1,
		id: "0xdep",
		direction: "deposit",
		isPrivate: false,
		amount: "100000000",
		createdAt: 1,
		updatedAt: 2,
		...DEPLOY,
		recipient: "0xrecipient",
		secretHashHex: "0xdep",
		secret: "0xplaintext-bearer-secret",
		depositTxHash: "0xtx",
		leafIndex: "7",
		...over,
	}
}

function privateDeposit(): DepositJournalRecord {
	return publicDeposit({
		id: "0xpriv",
		secretHashHex: "0xpriv",
		isPrivate: true,
		secret: undefined,
		sealedEnvelope: "inner-blob",
		sealerL1: SEALER,
	})
}

function withdraw(over: Partial<WithdrawJournalRecord> = {}): WithdrawJournalRecord {
	return {
		schema: 1,
		id: "0xexit",
		direction: "withdraw",
		isPrivate: false,
		amount: "40000000",
		createdAt: 1,
		updatedAt: 2,
		...DEPLOY,
		recipientL1: SEALER,
		exitTxHash: "0xexit",
		...over,
	}
}

describe("bridge backup files", () => {
	it("round-trips public deposit, private deposit, and withdraw records", async () => {
		for (const rec of [publicDeposit(), privateDeposit(), withdraw()]) {
			const file = await sealBridgeBackup(key, rec, SEALER)
			expect(file.format).toBe("unleashed-bridge-backup")
			expect(file.id).toBe(rec.id)
			const reopened = await openBridgeBackup(key, file)
			expect(reopened).toEqual(rec)
		}
	})

	it("the file NEVER contains the plaintext claim secret (seal-everything)", async () => {
		const file = await sealBridgeBackup(key, publicDeposit(), SEALER)
		expect(JSON.stringify(file)).not.toContain("0xplaintext-bearer-secret")
	})

	it("wrong wallet key refuses with the attribution-honest copy", async () => {
		const file = await sealBridgeBackup(key, publicDeposit(), SEALER)
		expect(openBridgeBackup(otherKey, file)).rejects.toThrow(
			/wasn't sealed by the connected Ethereum account, or the file is corrupted/,
		)
	})

	it("a tampered blob refuses (GCM auth)", async () => {
		const file = await sealBridgeBackup(key, publicDeposit(), SEALER)
		const tampered: BridgeBackupFile = { ...file, blob: `${file.blob.slice(0, -4)}AAAA` }
		expect(openBridgeBackup(key, tampered)).rejects.toThrow(/corrupted|tampered/)
	})

	it("a swapped header (unauthenticated) is caught against the sealed copies", async () => {
		const file = await sealBridgeBackup(key, publicDeposit(), SEALER)
		expect(openBridgeBackup(key, { ...file, id: "0xother" })).rejects.toThrow(/label doesn't match its sealed contents/)
		expect(openBridgeBackup(key, { ...file, chainId: 1 })).rejects.toThrow(/label doesn't match/)
		expect(openBridgeBackup(key, { ...file, direction: "withdraw" })).rejects.toThrow(/label doesn't match/)
	})

	it("a private deposit without its sealed envelope refuses to export (no false recovery promise)", async () => {
		const unsealed = publicDeposit({ id: "0xunsealed", secretHashHex: "0xunsealed", isPrivate: true, secret: undefined })
		expect(sealBridgeBackup(key, unsealed, SEALER)).rejects.toThrow(/hasn't sealed its recovery secret/)
	})

	it("a swapped sealerL1 header on a private deposit is caught against the sealed copy", async () => {
		const file = await sealBridgeBackup(key, privateDeposit(), SEALER)
		await expect(openBridgeBackup(key, { ...file, sealerL1: "0xevil" })).rejects.toThrow(/label doesn't match/)
	})

	it("provisional withdraws refuse at seal AND at parse", async () => {
		const prov = withdraw({ id: "wd-pending-abc12345", exitTxHash: undefined })
		expect(sealBridgeBackup(key, prov, SEALER)).rejects.toThrow(/nothing restorable/)
		const forged = { ...(await sealBridgeBackup(key, withdraw(), SEALER)), id: "wd-pending-abc12345" }
		expect(() => parseBackupFile(forged)).toThrow(/half-started withdraw/)
	})

	it("parseBackupFile ladder: junk, foreign format, future version, malformed fields", () => {
		expect(() => parseBackupFile("not json {")).toThrow(/not an Unleashed bridge recovery file/)
		expect(() => parseBackupFile({ format: "something-else" })).toThrow(/not an Unleashed bridge recovery file/)
		expect(() => parseBackupFile({ format: "unleashed-bridge-backup", v: 2 })).toThrow(/newer version/)
		expect(() => parseBackupFile({ format: "unleashed-bridge-backup", v: 1, chainId: "nope" })).toThrow(/malformed/)
	})

	it("schema-2 fuel records validate strictly; malformed fuel rejects restore", () => {
		const fuel = {
			amount: "250000000000000000",
			secret: "0xf00d",
			secretHashHex: "0xfeed",
			minOutput: "450000000000000000000",
			leafIndex: "7",
			received: "487000000000000000000",
			claimAttempt: true,
			consumed: false,
			standaloneClaimed: false,
		}
		const fueled = publicDeposit({ schema: 2, fuel } as never)
		expect(validateBackupRecord(fueled)).toEqual(fueled)
		// Tampered fuel amount (non-decimal) rejects.
		expect(() => validateBackupRecord(publicDeposit({ schema: 2, fuel: { ...fuel, amount: "12.5" } } as never))).toThrow(
			/not a valid bridge record/,
		)
		// Missing secret rejects.
		expect(() => validateBackupRecord(publicDeposit({ schema: 2, fuel: { ...fuel, secret: "" } } as never))).toThrow(
			/not a valid bridge record/,
		)
		// Schema 2 without a fuel block is a contradiction.
		expect(() => validateBackupRecord(publicDeposit({ schema: 2 } as never))).toThrow(/not a valid bridge record/)
		// Schema 1 carrying fuel is a contradiction.
		expect(() => validateBackupRecord(publicDeposit({ fuel } as never))).toThrow(/not a valid bridge record/)
		// The claimed-by-another flag is a milestone like the others: present ⇒ a boolean, never a string.
		expect(validateBackupRecord(publicDeposit({ claimedByOther: true }))).toMatchObject({ claimedByOther: true })
		expect(() => validateBackupRecord(publicDeposit({ claimedByOther: "yes" } as never))).toThrow(/not a valid bridge record/)
		// Withdraws never carry schema 2.
		expect(() => validateBackupRecord({ ...withdraw(), schema: 2 })).toThrow(/not a valid bridge record/)
	})

	it("fee-juice + private-fuel extras: assetKind + bridgeSecretSalt/fpc/setupInsufficiency validate strictly", async () => {
		const fuel = {
			amount: "250000000000000000",
			secret: "0xf00d",
			secretHashHex: "0xfeed",
			minOutput: "450000000000000000000",
			bridgeSecretSalt: "0x5a17",
			fpc: "0x1b1706cc0947eca1de6527562af65d43e95540f9009a896dcd847afea92ede1e",
			setupInsufficiency: false,
		}
		const fjPriv = publicDeposit({
			assetKind: "fee-juice",
			isPrivate: true,
			secret: undefined,
			sealedEnvelope: "blob",
			sealerL1: SEALER,
			schema: 2,
			fuel,
		} as never)
		// Round-trips with the variant + private extras intact.
		const file = await sealBridgeBackup(key, fjPriv, SEALER)
		expect(await openBridgeBackup(key, file)).toEqual(fjPriv)
		// Malformed private-fuel extras reject the restore (recovery inputs — never guessed through).
		expect(() => validateBackupRecord(publicDeposit({ schema: 2, fuel: { ...fuel, bridgeSecretSalt: 7 } } as never))).toThrow(
			/not a valid bridge record/,
		)
		expect(() => validateBackupRecord(publicDeposit({ schema: 2, fuel: { ...fuel, fpc: 7 } } as never))).toThrow(
			/not a valid bridge record/,
		)
		expect(() => validateBackupRecord(publicDeposit({ schema: 2, fuel: { ...fuel, setupInsufficiency: "nope" } } as never))).toThrow(
			/not a valid bridge record/,
		)
		// A bad assetKind rejects.
		expect(() => validateBackupRecord(publicDeposit({ assetKind: "garbage" } as never))).toThrow(/not a valid bridge record/)
	})

	it("validateBackupRecord rejects junk shapes the journal's shallow parser would let through", () => {
		expect(() => validateBackupRecord({ id: "0x1", direction: "deposit" })).toThrow(/not a valid bridge record/)
		expect(() => validateBackupRecord(publicDeposit({ amount: "12.5" as never }))).toThrow(/not a valid bridge record/)
		expect(() => validateBackupRecord({ ...withdraw(), recipientL1: undefined })).toThrow(/not a valid bridge record/)
		// And accepts the real shapes.
		expect(validateBackupRecord(publicDeposit())).toEqual(publicDeposit())
	})

	it("keeps a recorded sender through seal and open; a pre-field record and an unlisted key still validate", async () => {
		for (const rec of [publicDeposit({ sender: SEALER }), withdraw({ sender: `0x${"0a".repeat(32)}` })]) {
			expect(await openBridgeBackup(key, await sealBridgeBackup(key, rec, SEALER))).toEqual(rec)
		}
		const preField = await openBridgeBackup(key, await sealBridgeBackup(key, publicDeposit(), SEALER))
		expect(preField).not.toHaveProperty("sender")
		expect(validateAnyBackupRecord(preField)).toEqual(publicDeposit())
		// An older bundle's validator treats a newer optional field as unlisted, so this is what lets it load one.
		const future = { ...withdraw(), futureField: 1 }
		expect(validateBackupRecord(future)).toEqual(future)
	})

	it("a forged payload (valid JSON, wrong inner marker) refuses", async () => {
		const raw = JSON.stringify({ notBk: true })
		const enc = new TextEncoder().encode(raw)
		const blob = Buffer.from(await key.encrypt(enc)).toString("base64")
		const file = await sealBridgeBackup(key, publicDeposit(), SEALER)
		expect(openBridgeBackup(key, { ...file, blob })).rejects.toThrow(/not a valid bridge record/)
	})
})

// ── writer → validator round trip ────────────────────────────────────────────────────────────────

const CLONE = "0x00000000000000000000000000000000000000a1"
const HUB = `0x${"ab".repeat(32)}`
const FJ_PORTAL = "0x00000000000000000000000000000000000000f1"
const FEE_JUICE_L2 = `0x${"05".repeat(32)}`

const TOKEN_BLOCK: JournalTokenBlock = {
	erc20: "0x00000000000000000000000000000000000e2c20",
	portal: CLONE,
	l2Token: `0x${"11".repeat(32)}`,
	nameWord: `0x00${"4e".repeat(31)}`,
	symbolWord: `0x00${"54".repeat(31)}`,
	decimals: 18,
	displaySymbol: "TST",
	registerKey: `0x${"22".repeat(32)}`,
	registerIndex: "5",
}

/** Every fuel field a writer sets, in the shapes it sets them: the send's own pre-signature block,
 *  the receipt's event fields, and the claim ladder's latches. */
const FUEL_FULL = {
	amount: "250000000000000000",
	secret: "0xf00d",
	secretHashHex: "0xfeed",
	minOutput: "450000000000000000000",
	leafIndex: "8",
	messageHash: `0x${"fe".repeat(32)}`,
	received: "487000000000000000000",
	claimAttemptAt: 1_700_000_000_000,
	claimAttempt: true,
	claimTxHash: "0xfjclaim",
	consumed: true,
	standaloneClaimed: false,
	bridgeSecretSalt: `0x${"5a".repeat(32)}`,
	fpc: "0x1b1706cc0947eca1de6527562af65d43e95540f9009a896dcd847afea92ede1e",
	setupInsufficiency: false,
}

/** The two optionals every record shape can carry: the terminal block reason and the completion stamp. */
const BASE_SET = { blocked: "This token's registration on Ethereum no longer matches this record.", completedAt: 3 }

const sendBase = {
	...BASE_SET,
	schema: 3 as const,
	isPrivate: false,
	amount: "99000000",
	createdAt: 1,
	updatedAt: 2,
	chainId: 31337,
}

/** A public token+gas send with every optional field the deposit writers persist. */
function sendDepositPublic(over: Partial<SendDepositRecord> = {}): SendDepositRecord {
	return {
		...sendBase,
		id: "0xsendpub",
		direction: "deposit",
		intent: "token+gas",
		token: TOKEN_BLOCK,
		portal: CLONE,
		bridge: HUB,
		recipient: `0x${"10".repeat(32)}`,
		secretHashHex: "0xsendpub",
		secret: `0x${"07".repeat(32)}`,
		approveTxHash: "0xapprove",
		depositTxHash: "0xl1tx",
		leafIndex: "7",
		messageHash: `0x${"7e".repeat(32)}`,
		claimTxHash: "0xhubclaim",
		registerTxHash: "0xregister",
		depositL2Block: 42,
		fuel: FUEL_FULL,
		...over,
	} as SendDepositRecord
}

/** The private variant: the claim material is sealed, so the plaintext copy is gone and the
 *  envelope + its sealer take its place. */
const sendDepositPrivate = (): SendDepositRecord =>
	sendDepositPublic({
		id: "0xsendpriv",
		secretHashHex: "0xsendpriv",
		isPrivate: true,
		secret: undefined,
		sealedEnvelope: "sealed-blob",
		sealerL1: SEALER,
	})

/** Gas-only: no token block, bound to the Fee Juice portal, and its ONE claim secret lives in the
 *  fuel block rather than at the top level. */
const sendDepositGasOnly = (): SendDepositRecord =>
	sendDepositPublic({
		id: "0xsendgas",
		secretHashHex: "0xsendgas",
		intent: "gas",
		token: undefined,
		portal: FJ_PORTAL,
		bridge: FEE_JUICE_L2,
		secret: undefined,
		leafIndex: "8",
	} as Partial<SendDepositRecord>)

function sendExit(over: Partial<SendWithdrawRecord> = {}): SendWithdrawRecord {
	return {
		...sendBase,
		id: "0xexittx",
		direction: "withdraw",
		intent: "token",
		token: TOKEN_BLOCK,
		portal: CLONE,
		bridge: HUB,
		recipientL1: SEALER,
		exitTxHash: "0xexittx",
		exitBlock: 5,
		consumeTxHash: "0xconsume",
		consumedByOther: false,
		...over,
	} as SendWithdrawRecord
}

/** [field path, a value of the WRONG type a rewritten record could carry]. */
type WrongTyped = [string, unknown]

const BASE_WRONG: WrongTyped[] = [
	["blocked", 7],
	["completedAt", "soon"],
]

const DEPOSIT_WRONG: WrongTyped[] = [
	...BASE_WRONG,
	["secret", 7],
	["sealedEnvelope", 7],
	["sealerL1", 7],
	["approveTxHash", 7],
	["depositTxHash", 7],
	["leafIndex", 7],
	["messageHash", 7],
	["claimTxHash", 7],
	["registerTxHash", 7],
	["depositL2Block", "42"],
	["fuel.leafIndex", 7],
	["fuel.messageHash", 7],
	["fuel.received", "12.5"],
	["fuel.claimAttemptAt", "now"],
	["fuel.claimAttempt", "yes"],
	["fuel.claimTxHash", 7],
	["fuel.consumed", "yes"],
	["fuel.standaloneClaimed", "yes"],
	["fuel.bridgeSecretSalt", 7],
	["fuel.fpc", 7],
	["fuel.setupInsufficiency", "yes"],
]

const WITHDRAW_WRONG: WrongTyped[] = [
	...BASE_WRONG,
	["exitTxHash", 7],
	["exitBlock", "5"],
	["consumeTxHash", 7],
	["consumedByOther", "yes"],
]

/** Replace one field, or one field of the fuel block, leaving everything else as the writer left it. */
function mutate(rec: object, path: string, value: unknown): unknown {
	const [head, tail] = path.split(".")
	const r = rec as Record<string, unknown>
	return tail ? { ...r, [head]: { ...(r[head] as object), [tail]: value } } : { ...r, [head]: value }
}

describe("every persisted optional field is validated by type", () => {
	it("accepts each writer's record with every optional field set", () => {
		const written = [
			sendDepositPublic(),
			sendDepositPrivate(),
			sendDepositGasOnly(),
			sendExit(),
			sendExit({ id: "0xexitpriv", exitTxHash: "0xexitpriv", isPrivate: true }),
			publicDeposit({ schema: 2, fuel: FUEL_FULL, assetKind: "fee-juice", ...BASE_SET } as never),
			withdraw({ ...BASE_SET, exitBlock: 5, consumeTxHash: "0xconsume", consumedByOther: false } as never),
		]
		for (const rec of written) expect(validateAnyBackupRecord(rec)).toEqual(rec)
	})

	it.each(DEPOSIT_WRONG)("rejects a send deposit whose %s is the wrong type", (path, bad) => {
		expect(() => validateAnyBackupRecord(mutate(sendDepositPublic(), path, bad))).toThrow(/not a valid bridge record/)
	})

	it("`registers` is a flag or absent, kept on a token deposit, refused anywhere else", () => {
		expect(validateAnyBackupRecord(sendDepositPublic({ registers: true }))).toMatchObject({ registers: true })
		expect((validateAnyBackupRecord(sendDepositPublic()) as { registers?: unknown }).registers).toBeUndefined()
		expect(() => validateAnyBackupRecord(mutate(sendDepositPublic(), "registers", "yes"))).toThrow(/not a valid bridge record/)
		expect(() => validateAnyBackupRecord(mutate(sendDepositPublic(), "registers", false))).toThrow(/not a valid bridge record/)
		expect(() => validateAnyBackupRecord({ ...sendDepositGasOnly(), registers: true })).toThrow(/not a valid bridge record/)
	})

	it.each(WITHDRAW_WRONG)("rejects a send exit whose %s is the wrong type", (path, bad) => {
		expect(() => validateAnyBackupRecord(mutate(sendExit(), path, bad))).toThrow(/not a valid bridge record/)
	})

	it.each(BASE_WRONG)("rejects a public deposit whose %s is the wrong type", (path, bad) => {
		expect(() => validateAnyBackupRecord(mutate(publicDeposit(), path, bad))).toThrow(/not a valid bridge record/)
	})
})
