import { createHash } from "node:crypto"
import {
	type DepositJournalRecord,
	JOURNAL_KEY,
	type KeyText,
	type LegacyBridgeBackupFile,
	RecoveryKey,
	keyTextOf,
	openDepositEnvelope,
	recoveryKeyMessage,
	sealBridgeBackup,
	sealDepositEnvelope,
	upsertRecord,
} from "@unleashed/bridge-core"
import type { JournalTokenBlock } from "@unleashed/sdk"
import { feeJuiceAddress, predictPortal } from "@unleashed/sdk/protocol"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ref } from "vue"

/** A deterministic wallet: its signature hashes the exact text, so each text (and each wallet) has its own key. */
const sigOf = (message: string, wallet = "connected") => `0x${createHash("sha256").update(`${wallet}:${message}`).digest("hex")}`
const signMessage = vi.fn(async ({ message }: { message: string }) => sigOf(message))
const retainedKey = vi.fn((_id: string) => undefined as unknown)

vi.mock("@/contracts/bridge-generation", () => ({ FUEL_PORTAL: "0xfd05ee8687d4ca828ba3d26ef04b80dd1348e5bd" }))
vi.mock("./useL1Wallet", () => ({
	useL1Wallet: () => ({
		address: ref("0xef4d9e1f4e9e2dd9e747b53f4be3d04bfa935f2d"),
		ensureWalletClient: () => ({ signMessage }),
	}),
}))
vi.mock("./useSend", () => ({ getRetainedSealKey: (id: string) => retainedKey(id) }))
vi.mock("./deposit-flow", () => ({ providerFingerprint: () => "rabby" }))
const watchCrossChain = vi.fn(async (_id: string, _deps: unknown) => {})
vi.mock("./crosschain-deposit-flow", () => ({ appWatchDeps: () => ({}), crossChainSealKey: () => undefined }))
vi.mock("./crosschain-watch", () => ({
	needsWatch: (rec: { completedAt?: number; route: { outcome?: string; depositFinal?: true } }) =>
		rec.completedAt === undefined && (rec.route.outcome !== undefined || rec.route.depositFinal !== true),
	watchCrossChain: (id: string, deps: unknown) => watchCrossChain(id, deps),
}))

import { __resetJournalForTests, addRecord, connectJournalDeps, useBridgeJournal } from "./useBridgeJournal"
import { xcRecord } from "@/test/crosschain-record"
import { useBridgeBackup } from "./useBridgeBackup"
import { NETWORK } from "@/lib/network"
import { recoveryBindingOf } from "@/lib/send-record"

// A direct Fee Juice bridge: the one pre-generation shape whose recovery file still restores here.
const DEPLOY = { chainId: 11155111, portal: "0xfd05ee8687d4ca828ba3d26ef04b80dd1348e5bd", bridge: feeJuiceAddress.toString() }

function publicDeposit(over: Partial<DepositJournalRecord> = {}): DepositJournalRecord {
	return {
		schema: 1,
		id: "0xbk",
		direction: "deposit",
		isPrivate: false,
		assetKind: "fee-juice",
		amount: "100000000",
		createdAt: 1,
		updatedAt: 2,
		...DEPLOY,
		recipient: "0xrecipient",
		secretHashHex: "0xbk",
		secret: "0xbearer",
		leafIndex: "7",
		...over,
	}
}

const keyFor = <T extends KeyText>(rec: DepositJournalRecord, text: T, wallet = "connected") =>
	RecoveryKey.derive(async (m) => sigOf(m, wallet), recoveryBindingOf(rec, rec.id), text)
const textFor = (rec: DepositJournalRecord, text: KeyText) => recoveryKeyMessage(recoveryBindingOf(rec, rec.id), text)
const signedTexts = () => signMessage.mock.calls.map(([{ message }]) => message)

/** What the format-1 exporter wrote: the exporting account in the header, the blob under a legacy key. */
async function legacyFileFor(rec: DepositJournalRecord): Promise<LegacyBridgeBackupFile> {
	const { chainId, portal, bridge, direction, id } = rec
	const blob = await (await keyFor(rec, "legacy")).seal(JSON.stringify({ bk: 1, record: rec }))
	return { format: "unleashed-bridge-backup", v: 1, chainId, portal, bridge, direction, id, sealerL1: "0xme", blob }
}

/** Runs the export and returns the downloaded file's text. */
async function exported(rec: DepositJournalRecord): Promise<string> {
	let file: Blob | undefined
	URL.createObjectURL = vi.fn((blob: Blob) => {
		file = blob
		return "blob:fake"
	})
	vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {})
	await useBridgeBackup().exportBridge(rec)
	return (file as Blob).text()
}

function memKV() {
	const store = new Map<string, string>()
	return {
		getItem: (k: string) => store.get(k) ?? null,
		setItem: (k: string, v: string) => void store.set(k, v),
		removeItem: (k: string) => void store.delete(k),
	}
}

describe("useBridgeBackup", () => {
	beforeEach(() => {
		vi.restoreAllMocks() // prototype spies (anchor click) must not leak across tests.
		__resetJournalForTests()
		connectJournalDeps({ kv: memKV(), now: () => 999 })
		signMessage.mockReset() // implementations persist past mockClear - reset + re-prime.
		signMessage.mockImplementation(async ({ message }: { message: string }) => sigOf(message))
		retainedKey.mockReturnValue(undefined)
		localStorage.clear()
		// jsdom lacks createObjectURL; the download path needs both stubs.
		URL.createObjectURL = vi.fn(() => "blob:fake")
		URL.revokeObjectURL = vi.fn()
	})

	it("first export on an untrusted wallet runs the determinism self-test (two signatures), then trusts", async () => {
		const clicks: string[] = []
		vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
			clicks.push(this.download)
		})
		const backup = useBridgeBackup()
		await backup.exportBridge(publicDeposit())
		expect(signedTexts()).toEqual([textFor(publicDeposit(), "site"), textFor(publicDeposit(), "site")])
		expect(signedTexts()[0]).toContain("\nSite: https://testnet.app.unleashed.systems\n")
		expect(NETWORK.appOrigin).toBe("https://testnet.app.unleashed.systems")
		expect(clicks).toEqual(["unleashed-bridge-deposit-0xbk.json"])

		signMessage.mockClear()
		await backup.exportBridge(publicDeposit({ id: "0xbk2", secretHashHex: "0xbk2" }))
		expect(signMessage).toHaveBeenCalledTimes(1) // trusted now - single signature.
	})

	it("a non-deterministic signer aborts the export BEFORE any file exists", async () => {
		let n = 0
		signMessage.mockImplementation(async () => `0xrandom-${n++}`)
		const clicks = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {})
		await expect(useBridgeBackup().exportBridge(publicDeposit())).rejects.toThrow(/signs non-deterministically/)
		expect(clicks).not.toHaveBeenCalled()
	})

	it("a same-session retained key exports with ZERO signatures, and the file restores under the site text", async () => {
		const rec = publicDeposit()
		retainedKey.mockReturnValue(await keyFor(rec, "site"))
		const file = await exported(rec)
		expect(signMessage).not.toHaveBeenCalled()
		retainedKey.mockReturnValue(undefined)
		expect((await useBridgeBackup().restoreFile(file)).id).toBe(rec.id)
		expect(signedTexts()).toEqual([textFor(rec, "site")])
	})

	it("a format-1 file restores under the legacy text with one signature; a retained site key is not used", async () => {
		const rec = publicDeposit()
		retainedKey.mockReturnValue(await keyFor(rec, "site"))
		expect((await useBridgeBackup().restoreFile(JSON.stringify(await legacyFileFor(rec)))).id).toBe(rec.id)
		expect(signedTexts()).toEqual([textFor(rec, "legacy")])
	})

	it("a file exported by another account than the record's sealer restores for that account; format 1 refused it", async () => {
		const sealer = "0x5ea1e5000000000000000000000000000000005e"
		const rec = publicDeposit({ isPrivate: true, secret: undefined, sealerL1: sealer })
		const envelope = { secret: "0xclaimsalt", recipient: rec.recipient, amount: rec.amount, sealerL1: sealer }
		rec.sealedEnvelope = await sealDepositEnvelope(await keyFor(rec, "site", "sealer"), envelope)
		const file = await exported(rec)
		expect(JSON.parse(file)).not.toHaveProperty("sealerL1")
		expect((await useBridgeBackup().restoreFile(file)).id).toBe(rec.id)

		__resetJournalForTests()
		connectJournalDeps({ kv: memKV(), now: () => 999 })
		await expect(useBridgeBackup().restoreFile(JSON.stringify(await legacyFileFor(rec)))).rejects.toThrow(
			/label doesn.t match its sealed contents/,
		)
	})

	it("a record sealed under the legacy text exports into a new file whose envelope still opens under the legacy text", async () => {
		const rec = publicDeposit({ isPrivate: true, secret: undefined, sealerL1: "0xef4d9e1f4e9e2dd9e747b53f4be3d04bfa935f2d" })
		const envelope = { secret: "0xclaimsalt", recipient: rec.recipient, amount: rec.amount, sealerL1: rec.sealerL1 as string }
		rec.sealedEnvelope = await sealDepositEnvelope(await keyFor(rec, "legacy"), envelope)
		const file = await exported(rec)
		expect([JSON.parse(file).v, keyTextOf(JSON.parse(file).blob)]).toEqual([2, "site"])
		signMessage.mockClear()
		const restored = (await useBridgeBackup().restoreFile(file)) as DepositJournalRecord
		expect(signedTexts()).toEqual([textFor(rec, "site")])
		expect(keyTextOf(restored.sealedEnvelope as string)).toBe("legacy")
		expect((await openDepositEnvelope(await keyFor(rec, "legacy"), restored.sealedEnvelope as string)).secret).toBe("0xclaimsalt")
	})

	it("restore ladder: foreign deployment and duplicates refuse before any signature", async () => {
		const backup = useBridgeBackup()
		const key = await keyFor(publicDeposit(), "site")
		const foreign = await sealBridgeBackup(key, publicDeposit({ chainId: 1 }))
		await expect(backup.restoreFile(JSON.stringify(foreign))).rejects.toThrow(/different bridge deployment/)

		addRecord(publicDeposit())
		const dup = await sealBridgeBackup(key, publicDeposit())
		await expect(backup.restoreFile(JSON.stringify(dup))).rejects.toThrow(/already tracked/)
		expect(signMessage).not.toHaveBeenCalled()
	})

	it("restore happy path: one signature, record lands in the journal as a normal idle card", async () => {
		const rec = publicDeposit()
		const file = await sealBridgeBackup(await keyFor(rec, "site"), rec)

		const restored = await useBridgeBackup().restoreFile(JSON.stringify(file))
		expect(restored.id).toBe(rec.id)
		expect(signedTexts()).toEqual([textFor(rec, "site")])
		const { records, runtime } = useBridgeJournal()
		// The journal re-stamps updatedAt on write - everything else round-trips exactly.
		const { updatedAt: _stamped, ...stored } = records.value.find((r) => r.id === rec.id) as DepositJournalRecord
		const { updatedAt: _orig, ...original } = rec
		expect(stored).toEqual(original)
		expect(runtime.value[rec.id]?.busy).toBeUndefined() // idle - no auto-claim.
	})

	it("a restore whose bridge another tab files during its signature resolves, and the stored copy stands", async () => {
		const rec = publicDeposit()
		const file = await sealBridgeBackup(await keyFor(rec, "site"), rec)
		const kv = memKV()
		connectJournalDeps({ kv })
		let filed: string | null = null
		signMessage.mockImplementation(async ({ message }: { message: string }) => {
			upsertRecord(kv, { ...rec, claimTxHash: "0xclaimed" })
			filed = kv.getItem(JOURNAL_KEY)
			return sigOf(message)
		})
		await expect(useBridgeBackup().restoreFile(JSON.stringify(file))).resolves.toMatchObject({ id: rec.id })
		expect(kv.getItem(JOURNAL_KEY)).toBe(filed)
	})

	it("restore with the wrong wallet's file refuses with the attribution-honest copy", async () => {
		const rec = publicDeposit()
		const file = await sealBridgeBackup(await keyFor(rec, "site", "someone-else"), rec)
		await expect(useBridgeBackup().restoreFile(JSON.stringify(file))).rejects.toThrow(/wasn't sealed by the connected|corrupted/)
		expect(useBridgeJournal().records.value).toHaveLength(0)
	})

	describe("send (schema 3) files", () => {
		const FACTORY = "0x5eb3bc0a489c5a8288765d2336659ebca68fcd00"
		const IMPLEMENTATION = "0xc95ff0608561b6ba084c78d14f09e9826190f968"
		const ERC20 = "0x70e0ba845a1a0f2da3359c97e0285013525ffc49"
		const HUB = `0x${"b".repeat(64)}`
		const CLONE = predictPortal(FACTORY, IMPLEMENTATION, ERC20)

		const sendRecord = () =>
			({
				...publicDeposit(),
				schema: 3,
				intent: "token",
				token: {
					erc20: ERC20,
					portal: CLONE,
					l2Token: `0x${"c".repeat(64)}`,
					nameWord: `0x${"1".repeat(64)}`,
					symbolWord: `0x${"2".repeat(64)}`,
					decimals: 6,
					displaySymbol: "USDC",
					registerKey: `0x${"4".repeat(64)}`,
					registerIndex: "3",
				},
				portal: CLONE,
				bridge: HUB,
			}) as unknown as DepositJournalRecord

		const wireSend = (validateTokenBlock: () => Promise<string | null>) =>
			connectJournalDeps({
				sendBinding: () => ({
					factory: FACTORY,
					implementation: IMPLEMENTATION,
					hub: HUB,
					feeJuicePortal: "0xfd05ee8687d4ca828ba3d26ef04b80dd1348e5bd",
				}),
				validateTokenBlock,
			})

		const fileFor = async (rec: DepositJournalRecord) => sealBridgeBackup(await keyFor(rec, "site"), rec)

		it("a file naming this generation's hub restores once its block still matches the factory", async () => {
			wireSend(async () => null)
			const file = await fileFor(sendRecord())
			const restored = await useBridgeBackup().restoreFile(JSON.stringify(file))
			expect(restored.schema).toBe(3)
			expect(useBridgeJournal().records.value).toHaveLength(1)
		})

		it("a block the factory contradicts is refused - the record is never tracked", async () => {
			wireSend(async () => "This token's registration on Ethereum no longer matches this record.")
			const file = await fileFor(sendRecord())
			await expect(useBridgeBackup().restoreFile(JSON.stringify(file))).rejects.toThrow(/no longer matches/)
			expect(useBridgeJournal().records.value).toHaveLength(0)
		})

		it("a cross-chain record exports and restores under its own key, and a send still on its way is watched", async () => {
			wireSend(async () => null)
			const rec = xcRecord(
				{ portal: CLONE, bridge: HUB, token: (sendRecord() as unknown as { token: JournalTokenBlock }).token },
				{ srcTxHash: `0x${"57".repeat(32)}` },
			)
			let file: Blob | undefined
			URL.createObjectURL = vi.fn((blob: Blob) => {
				file = blob
				return "blob:fake"
			})
			vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {})
			await useBridgeBackup().exportBridge(rec)
			const restored = await useBridgeBackup().restoreFile(await (file as Blob).text())
			const { records, crossChainRecords } = useBridgeJournal()
			expect(restored.schema).toBe(4)
			expect(records.value).toHaveLength(0)
			const { updatedAt: _stamped, ...stored } = crossChainRecords.value[0] as typeof rec
			const { updatedAt: _orig, ...original } = rec
			expect(stored).toEqual(original)
			expect(watchCrossChain).toHaveBeenCalledWith(rec.id, expect.anything())
		})

		it("a file that calls its deposit final is watched until discovery says so again", async () => {
			wireSend(async () => null)
			const rec = xcRecord(
				{ portal: CLONE, bridge: HUB, token: (sendRecord() as unknown as { token: JournalTokenBlock }).token, leafIndex: "7" },
				{ srcTxHash: `0x${"57".repeat(32)}`, depositFinal: true },
			)
			let file: Blob | undefined
			URL.createObjectURL = vi.fn((blob: Blob) => {
				file = blob
				return "blob:fake"
			})
			vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {})
			await useBridgeBackup().exportBridge(rec)
			await useBridgeBackup().restoreFile(await (file as Blob).text())
			expect(useBridgeJournal().crossChainRecords.value[0]?.route.depositFinal).toBeUndefined()
			expect(watchCrossChain).toHaveBeenCalledWith(rec.id, expect.anything())
		})

		it("a file naming another hub never reaches the unseal", async () => {
			wireSend(async () => null)
			const file = await fileFor({ ...sendRecord(), bridge: `0x${"9".repeat(64)}` } as DepositJournalRecord)
			await expect(useBridgeBackup().restoreFile(JSON.stringify(file))).rejects.toThrow(/different bridge deployment/)
			expect(signMessage).not.toHaveBeenCalled()
		})
	})
})
