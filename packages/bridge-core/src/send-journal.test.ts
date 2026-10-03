import { EncryptionKey } from "@alejoamiras/nulo-wallet-crypto"
import { describe, expect, it } from "vitest"
import { openBridgeBackup, sealBridgeBackup, validateAnyBackupRecord } from "./backup"
import {
	assetKindOf,
	deriveSendDepositStage,
	isSendRecord,
	type JournalTokenBlock,
	type KV,
	loadJournal,
	type SendDepositRecord,
	type SendWithdrawRecord,
	upsertRecord,
} from "./journal"

const SEALER = "0xef4d9e1f4e9e2dd9e747b53f4be3d04bfa935f2d"
const HUB = `0x${"ab".repeat(32)}`
const PORTAL_A = "0x00000000000000000000000000000000000000a1"
const PORTAL_B = "0x00000000000000000000000000000000000000b1"
const key = await EncryptionKey.fromPassword("0xsig-deterministic")

const tokenA: JournalTokenBlock = {
	erc20: "0x00000000000000000000000000000000000e2c20",
	portal: PORTAL_A,
	l2Token: `0x${"11".repeat(32)}`,
	nameWord: `0x00${"4e".repeat(31)}`,
	symbolWord: `0x00${"54".repeat(31)}`,
	decimals: 18,
	displaySymbol: "TST",
	registerKey: `0x${"22".repeat(32)}`,
	registerIndex: "5",
}

function sendDeposit(over: Partial<SendDepositRecord> = {}): SendDepositRecord {
	return {
		schema: 3,
		id: "0xsend",
		direction: "deposit",
		isPrivate: false,
		amount: "1000",
		createdAt: 1,
		updatedAt: 2,
		chainId: 31337,
		portal: PORTAL_A,
		bridge: HUB,
		recipient: "0xrecipient",
		secretHashHex: "0xsend",
		secret: "0xsecret",
		intent: "token",
		token: tokenA,
		...over,
	} as SendDepositRecord
}

function memoryKv(): KV {
	const m = new Map<string, string>()
	return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) }
}

describe("schema-3 send records", () => {
	it("load beside schema-1 records and derive the register stage", () => {
		const kv = memoryKv()
		upsertRecord(kv, sendDeposit())
		upsertRecord(kv, { ...sendDeposit({ id: "0xschema1" }), schema: 1, intent: undefined, token: undefined } as never)
		const loaded = loadJournal(kv)
		expect(loaded.map((r) => r.schema)).toEqual([3, 1])
		expect(isSendRecord(loaded[0])).toBe(true)
		expect(assetKindOf(sendDeposit({ intent: "gas", token: undefined } as never))).toBe("fee-juice")
		expect(assetKindOf(sendDeposit())).toBe("bridge-token")

		expect(deriveSendDepositStage(sendDeposit())).toBe("depositing")
		expect(deriveSendDepositStage(sendDeposit({ leafIndex: "9", registerTxHash: "0xreg" }))).toBe("registering")
		expect(deriveSendDepositStage(sendDeposit({ leafIndex: "9" }), { claimable: true })).toBe("claimable")
		expect(deriveSendDepositStage(sendDeposit({ leafIndex: "9", claimTxHash: "0xc" }))).toBe("claiming")
	})

	it("round-trips through a sealed backup with the token block intact", async () => {
		const rec = sendDeposit({ registerTxHash: "0xreg" })
		const file = await sealBridgeBackup(key, rec, SEALER)
		const back = (await openBridgeBackup(key, file)) as SendDepositRecord
		expect(back.schema).toBe(3)
		expect(back.intent).toBe("token")
		expect(back.token).toEqual(tokenA)
		expect(back.registerTxHash).toBe("0xreg")

		const wd: SendWithdrawRecord = {
			schema: 3,
			id: "0xexit",
			direction: "withdraw",
			isPrivate: true,
			amount: "5",
			createdAt: 1,
			updatedAt: 2,
			chainId: 31337,
			portal: PORTAL_A,
			bridge: HUB,
			recipientL1: "0x00000000000000000000000000000000000000ee",
			exitTxHash: "0xexit",
			intent: "token",
			token: tokenA,
		}
		expect((await openBridgeBackup(key, await sealBridgeBackup(key, wd, SEALER))).schema).toBe(3)
	})

	it("fails closed on a missing, malformed, or cross-token block", () => {
		const invalid = "The sealed contents are not a valid bridge record."
		expect(() => validateAnyBackupRecord({ ...sendDeposit(), token: undefined })).toThrow(invalid)
		expect(() => validateAnyBackupRecord(sendDeposit({ token: { ...tokenA, decimals: 256 } }))).toThrow(invalid)
		expect(() => validateAnyBackupRecord(sendDeposit({ token: { ...tokenA, l2Token: "0x1" } }))).toThrow(invalid)
		// The block names portal B while the record is bound to clone A — a claim rebuilt from it
		// would target another token.
		expect(() => validateAnyBackupRecord(sendDeposit({ token: { ...tokenA, portal: PORTAL_B } }))).toThrow(invalid)
		// Gas-only carries no block; a withdraw is always token-only.
		expect(() => validateAnyBackupRecord(sendDeposit({ intent: "gas" } as never))).toThrow(invalid)
		expect(() =>
			validateAnyBackupRecord({
				...sendDeposit(),
				direction: "withdraw",
				intent: "token+gas",
				recipientL1: "0xee",
				exitTxHash: "0x1",
			}),
		).toThrow(invalid)
		expect(() => validateAnyBackupRecord(sendDeposit({ intent: "swap" } as never))).toThrow(invalid)
		expect(validateAnyBackupRecord(sendDeposit({ intent: "gas", token: undefined } as never)).schema).toBe(3)
	})
})
